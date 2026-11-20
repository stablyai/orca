# Self-hosted relay authentication

This single-tenant service issues host-control tokens for Orca's relay. It has one administrator and no external identity provider. Serve it behind HTTPS with a trusted reverse proxy; packaged desktop builds reject HTTP, even on loopback. Keep the auth service and relay reachable by the desktop. Configure the desktop with `ORCA_CLOUD_API_URL=https://auth.example`, `ORCA_CLOUD_CLIENT_ID=orca-desktop` and `ORCA_RELAY_URL=https://relay.example`.

From `cloud/`, build with `pnpm --filter @orca-cloud/relay-auth build` and start with `pnpm --filter @orca-cloud/relay-auth start`. Node 24 or newer is required. Configure:

- `ORCA_AUTH_ISSUER`: canonical public HTTPS origin, or loopback HTTP for development; must equal relay `ORCA_RELAY_AUTH_ISSUER`.
- `ORCA_AUTH_ADMIN_SECRET`: randomly generated secret of at least 32 characters.
- `ORCA_AUTH_EMAIL`: administrator email; `ORCA_AUTH_USER_ID` defaults to `admin` and must remain stable.
- `ORCA_AUTH_CLIENT_ID`: desktop client ID, default `orca-desktop`.
- `ORCA_AUTH_DATA_DIR`: persistent directory, default `./data/relay-auth`; contains the SQLite database and generated private key. Restrict access and back it up securely.
- `ORCA_AUTH_SIGNING_KEY_FILE`: optional PEM PKCS#8 P-256 private key. Otherwise the service generates `signing-key.pem` in the data directory on first start.
- `ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE`: optional PEM SPKI public key retained in JWKS during rotation.
- `ORCA_AUTH_TRUST_PROXY`: set to `true` only when all clients reach the service through a trusted proxy that overwrites the rightmost `X-Forwarded-For` address; default `false` uses the socket address.
- `PORT`: listen port, default 8080.

For rotation, preserve the old public key (`openssl pkey -in signing-key.pem -pubout -out previous.pem`), configure its path in `ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE`, replace the private key with a fresh PKCS#8 P-256 key, and restart. Keep the old public key available until all issued relay tokens have expired and relay JWKS caches have refreshed. Avoid overlapping rotations before that point. Do not delete the SQLite database or signing key on restart.

Login failures are limited to ten per IP and 100 globally per minute. Run one auth instance only; the limiter and key initialization are not coordinated across instances. The service limits request bodies to 8 KiB; also apply limits at the reverse proxy. Refresh tokens rotate, with a 60-second replay grace for ambiguous network failures; later reuse revokes the session and its access tokens. Successor tokens are encrypted using a key derived from the admin secret during the grace period; changing the secret can disrupt a pending retry.

## Client contract

All JSON POST responses are JSON, and errors have `{ "error": "code" }`. The service returns 400 for malformed input, 401 for invalid credentials or tokens, 403 for an unknown organization, 429 for login throttling, and 501 for disabled connectors. Access credentials and refresh credentials are opaque. Access credentials last 15 minutes; sessions and refresh credentials last 30 days from sign-in or profile creation.

- `GET /v1/desktop/auth/authorize`: query `client_id`, `response_type=code`, `redirect_uri`, `scope`, `nonce`, `state`, `code_challenge`, `code_challenge_method=S256`, `local_profile_id`. The loopback redirect must be `http://127.0.0.1:<port>/auth/callback`. The browser submits the admin secret to the same URL as form field `secret`; success redirects to the loopback URI with `code` and `state`. Codes expire after five minutes and are single-use.
- `POST /v1/desktop/auth/session`: `{code, codeVerifier, nonce, redirectUri, state, localProfileId}`; validates all bindings and S256 PKCE. Returns the session object below.
- `POST /v1/desktop/auth/refresh`: `{refreshToken}`; rotates the refresh token and returns the session object. Replay within 60 seconds returns the current successor; later reuse returns `refresh_token_reuse` and revokes the family.
- `POST /v1/desktop/auth/capabilities`: bearer access token, `{}`; returns `{cloud, organizations, capabilities}`.
- `POST /v1/desktop/auth/profile`: bearer access token and `{refreshToken, name?, orgId?}`; validates the current refresh token and returns a new independent profile session. Organization selection is unsupported.
- `POST /v1/desktop/auth/org`: bearer access token and `{orgId}`; this single-tenant service has no organizations and returns `organization_not_found`.
- `POST /v1/desktop/auth/logout`: bearer access token and `{refreshToken}`; revokes that session, returns `{ok:true}`.
- `POST /v1/desktop/auth/relay-token`: bearer access token and `{relayHostId, hostPublicKeyB64}`; public key is canonical padded base64 of the 32 raw X25519 bytes. `relayHostId` must equal the first 16 characters of base64url(SHA-256(raw key)). Returns `{relayToken, expiresAt}` with expiration in Unix milliseconds.
- `POST /v1/desktop/auth/connector-token`: bearer access token; returns `connector_disabled` (501).
- `GET /.well-known/jwks.json`: ES256 public JWKS with `kid`. `GET /healthz`: `{ok:true}`.

A session object is `{accessToken, refreshToken, expiresAt, cloud, organizations, capabilities}`. `cloud` has `cloudProfileId`, `userId`, `email`, and `linkedAt`; organizations is an empty array; capabilities includes `flags` and millisecond `refreshedAt`. Relay JWTs have `sub`, `prof`, `relayHostId`, `purpose=host-control`, `iss`, `aud=orca-relay`, `iat`, and `exp` (seconds); they last five minutes. No `org` is issued.

## Relay configuration

Build each Dockerfile from the `cloud/` context. Both Docker images were built with Podman 5.4.2 and exercised on a Debian 13 builder (token mint accepted by the relay, tampered token rejected with 401). For a combined relay set `ORCA_RELAY_ROLE=combined`, `ORCA_RELAY_PUBLIC_URL` and `ORCA_RELAY_CELL_URL` to its public HTTPS origin, `ORCA_RELAY_AUTH_ISSUER` to the auth public origin, `ORCA_RELAY_AUTH_AUDIENCE=orca-relay`, `ORCA_RELAY_JWKS_URL` to the auth origin's `/.well-known/jwks.json`, `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY` to a separate random secret of at least 32 characters, `ORCA_RELAY_ADMIN_AUDIENCE` to a URL, `ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT` to an email, `ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED=true`, and `ORCA_RELAY_DATA_DIR` to persistent storage. See the relay README for network and operational configuration.
