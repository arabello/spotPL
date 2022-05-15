import { either, option, task, taskEither } from "fp-ts";
import open from "open";
import { URLSearchParams } from "url";
import dotenv from "dotenv";
import { pipe } from "fp-ts/function";
import express from "express";
import crypto from "crypto";
import randomstring from "randomstring";
import axios from "axios";
import base64url from "base64url";

dotenv.config();

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_REDIRECT_URI = `${process.env.SPOTIFY_REDIRECT_URI_HOST}:${process.env.SPOTIFY_REDIRECT_URI_PORT}${process.env.SPOTIFY_REDIRECT_URI_PATH}`;

type AuthParams = {
  state: string;
};

type AuthParamsError = AuthParams & { error: string };
type AuthParamsSuccess = AuthParams & { code: string };

const foldAuthParams: <T>(match: {
  error: (params: AuthParamsError) => T;
  success: (params: AuthParamsSuccess) => T;
  other: () => T;
}) => (params: any) => T = (match) => (params) => {
  if ("state" in params && "code" in params) {
    return match.success(params);
  } else if ("state" in params && "error" in params) {
    return match.error(params);
  } else {
    return match.other();
  }
};

const authorizeEndpoint = "https://accounts.spotify.com/authorize";
const makeAuthorizeParams = (code_verifier: string) => ({
  response_type: "code",
  client_id: SPOTIFY_CLIENT_ID,
  scope: "",
  redirect_uri: SPOTIFY_REDIRECT_URI,
  state: randomstring.generate(16),
  code_challenge_method: "S256",
  code_challenge: base64url.encode(
    Buffer.from(crypto.createHash("sha256").update(code_verifier).digest())
  ),
});

type AccessTokenSuccess = {
  access_token: string;
  token_type: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
};

const tokenEndpoint = "https://accounts.spotify.com/api/token";
const tokenParams = (code: string, code_verifier: string) => ({
  grant_type: "authorization_code",
  code,
  redirect_uri: SPOTIFY_REDIRECT_URI,
  client_id: SPOTIFY_CLIENT_ID,
  code_verifier: code_verifier,
});

class User {
  private accessToken: option.Option<string> = option.none;

  setAccessToken(accessToken: string) {
    this.accessToken = option.some(accessToken);
  }

  getAccessToken(): option.Option<string> {
    return this.accessToken;
  }
}

const user = new User();

const makeCallbackServer = (
  code_verifier: string,
  onSuccess: (data: AccessTokenSuccess) => void = () => {}
) => {
  const app = express();
  const server = app.listen(process.env.SPOTIFY_REDIRECT_URI_PORT, () => {
    console.log(
      `Redirect URI callback listening on port ${process.env.SPOTIFY_REDIRECT_URI_PORT} ...`
    );
  });

  app.get(process.env.SPOTIFY_REDIRECT_URI_PATH, (req, res) =>
    pipe(
      req.query,
      foldAuthParams({
        error: (params) =>
          taskEither.of(res.send(`Login failed: ${params.error}`)),
        success: (params) =>
          taskEither.tryCatch(async () => {
            const tokenReponse = await axios.post(
              tokenEndpoint,
              new URLSearchParams(
                tokenParams(params.code, code_verifier)
              ).toString(),
              {
                headers: {
                  "Content-Type": "application/x-www-form-urlencoded",
                },
              }
            );
            onSuccess(tokenReponse.data);
            server.close();
            return res.send("<script>window.close()</script>");
          }, either.toError),
        other: () =>
          taskEither.of(
            res.send("Login failed: Invalid response from Spotify")
          ),
      })
    )()
  );
};

export const login = pipe(
  taskEither.tryCatch(() => {
    const code_verifier = randomstring.generate(64);
    makeCallbackServer(code_verifier, (data) => {
      user.setAccessToken(data.access_token);
      console.log(user.getAccessToken());
    });

    return open(
      `${authorizeEndpoint}?${new URLSearchParams(
        makeAuthorizeParams(code_verifier)
      ).toString()}`
    );
  }, either.toError)
);
