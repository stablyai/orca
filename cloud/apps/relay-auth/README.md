# Self-hosted relay authentication

This single-tenant service issues host-control tokens for Orca's relay. It supports an administrator secret or an upstream OIDC identity provider. Serve it behind HTTPS with a trusted reverse proxy; packaged desktop builds reject HTTP, even on loopback. Keep the auth service and relay reachable by the desktop. Configure the desktop with `ORCA_CLOUD_API_URL=https://auth.example`, `ORCA_CLOUD_CLIENT_ID=orca-desktop` and `ORCA_RELAY_URL=https://relay.example`.

From `cloud/`, build with `pnpm --filter @orca-cloud/relay-auth build` and start with `pnpm --filter @orca-cloud/relay-auth start`. Node 24 or newer is required. Configure:

- `ORCA_AUTH_ISSUER`: canonical public HTTPS origin, or loopback HTTP for development; must equal relay `ORCA_RELAY_AUTH_ISSUER`.
- `ORCA_AUTH_ADMIN_SECRET`: randomly generated secret of at least 32 characters; required for secret login.
- `ORCA_AUTH_EMAIL`: administrator email, required for secret login; `ORCA_AUTH_USER_ID` defaults to `admin` and must remain stable.
- `ORCA_AUTH_CLIENT_ID`: desktop client ID (1–2,048 characters), default `orca-desktop`.
- `ORCA_AUTH_DATA_DIR`: persistent directory, default `./data/relay-auth`; contains the SQLite database and generated private key. Restrict access and back it up securely.
- `ORCA_AUTH_SIGNING_KEY_FILE`: optional PEM PKCS#8 P-256 private key. Otherwise the service generates `signing-key.pem` in the data directory on first start.
- `ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE`: optional PEM SPKI public key retained in JWKS during rotation.
- `ORCA_AUTH_TRUST_PROXY`: set to `true` only when all clients reach the service through a trusted proxy that overwrites the rightmost `X-Forwarded-For` address; default `false` uses the socket address.
- `PORT`: listen port, default 8080.

For rotation, preserve the old public key (`openssl pkey -in signing-key.pem -pubout -out previous.pem`), configure its path in `ORCA_AUTH_PREVIOUS_PUBLIC_KEY_FILE`, replace the private key with a fresh PKCS#8 P-256 key, and restart. Keep the old public key available until all issued relay tokens have expired and relay JWKS caches have refreshed. Avoid overlapping rotations before that point. Do not delete the SQLite database or signing key on restart.

Secret login failures are limited to ten per IP and 100 globally per minute; upstream callback failures are limited to ten per IP per minute, and upstream authorization starts to 30 per IP per minute. Up to 10,000 pending upstream authorizations are retained for five minutes. Audit logs contain reason codes only. Run one auth instance only; the limiter and key initialization are not coordinated across instances. The service limits request bodies to 8 KiB; also apply limits at the reverse proxy. Refresh tokens rotate, with a 60-second replay grace for ambiguous network failures; later reuse revokes the session and its access tokens. Successor tokens are encrypted using a key derived from the admin secret, or the signing key when no admin secret is configured; changing that key can disrupt a pending retry.

## Upstream OIDC (Zitadel)

Set `ORCA_AUTH_UPSTREAM_ISSUER` to the provider's exact HTTPS issuer (for example `https://id.example.com` or `https://id.example.com/realms/orca`); paths and a terminal slash are preserved for identity checks, while credentials, queries and fragments are rejected. Set `ORCA_AUTH_UPSTREAM_CLIENT_ID` to the provider application ID. Optionally set `ORCA_AUTH_UPSTREAM_CLIENT_SECRET` for a confidential client, `ORCA_AUTH_UPSTREAM_ALLOWED_EMAILS` and `ORCA_AUTH_UPSTREAM_ALLOWED_DOMAINS` to comma-separated lists, and `ORCA_AUTH_UPSTREAM_KEEP_SECRET_LOGIN=true` to retain admin-secret login. If either allowlist is nonempty, an email must match an address or a domain in those lists; matching is case-insensitive. When both lists are empty, startup fails unless `ORCA_AUTH_UPSTREAM_ALLOW_ANY=true` explicitly allows any authenticated provider user with a verified ASCII email. Secret login also requires `ORCA_AUTH_ADMIN_SECRET` and `ORCA_AUTH_EMAIL`; access its form by adding `secret_login=true` to the desktop authorization URL.

In Zitadel, create a Web application with authorization code flow and PKCE, allow the `email` scope, and register `${ORCA_AUTH_ISSUER}/v1/desktop/auth/upstream/callback` as its redirect URI (for example `https://orca.example.com/v1/desktop/auth/upstream/callback`). Public clients omit the secret. For confidential clients, the service chooses `client_secret_basic` when discovery advertises it, otherwise `client_secret_post` when supported; omitted discovery methods default to Basic per OIDC. Set `ORCA_AUTH_UPSTREAM_TOKEN_ENDPOINT_AUTH_METHOD=client_secret_basic` or `client_secret_post` to match the registered method explicitly. Basic encodes credentials in the Authorization header; Post sends the secret in the form body. The service discovers the provider and caches discovery for five minutes. Provider endpoints must use HTTPS and must not redirect; they must use the issuer origin unless `ORCA_AUTH_UPSTREAM_ALLOW_CROSS_ORIGIN=true` is set.

A user's stable relay subject is base64url(SHA-256(UTF-8 issuer)) followed by `:` and the provider's `sub`. Changing the issuer changes identities. Email and display name are taken from the ID token or, when missing, userinfo; a UserInfo failure is tolerated when only the optional display name is missing; the source of the email must assert `email_verified=true`. Relay token issuance, capabilities, refresh and profile creation recheck the current allowlist, and profile creation cannot extend the original session expiry. When upstream-only mode is enabled, legacy admin sessions cannot refresh or create profiles. Sessions created before verified-email tracking was added must sign in again before refresh or profile creation. SQLite adds nullable identity fields to existing codes and sessions; existing admin sessions retain their configured identity. Each new profile has its own profile ID while retaining the same user identity.

## Client contract

All JSON POST responses are JSON, and errors have `{ "error": "code" }`. The service returns 400 for malformed input, 401 for invalid credentials or tokens, 403 for an unknown organization, 429 for login throttling, and 501 for disabled connectors. Access credentials and refresh credentials are opaque. Access credentials last 15 minutes; sessions and refresh credentials last at most 30 days from sign-in; creating a profile does not extend that expiry.

- `GET /v1/desktop/auth/authorize`: query `client_id`, `response_type=code`, `redirect_uri`, `scope`, `nonce`, `state`, `code_challenge`, `code_challenge_method=S256`, `local_profile_id`. The loopback redirect must be `http://127.0.0.1:<port>/auth/callback`. In secret mode the browser submits the admin secret to the same URL as form field `secret`; upstream mode redirects to the provider. Success redirects to the loopback URI with `code` and `state`. Codes expire after five minutes and are single-use.
- `POST /v1/desktop/auth/session`: `{code, codeVerifier, nonce, redirectUri, state, localProfileId}`; validates all bindings and S256 PKCE. Returns the session object below.
- `POST /v1/desktop/auth/refresh`: `{refreshToken}`; rotates the refresh token and returns the session object. Replay within 60 seconds returns the current successor; later reuse returns `refresh_token_reuse` and revokes the family.
- `POST /v1/desktop/auth/capabilities`: bearer access token, `{}`; returns `{cloud, organizations, capabilities}`.
- `POST /v1/desktop/auth/profile`: bearer access token and `{refreshToken, name?, orgId?}`; validates the current refresh token and returns a new independent profile session. Organization selection is unsupported.
- `POST /v1/desktop/auth/org`: bearer access token and `{orgId}`; this single-tenant service has no organizations and returns `organization_not_found`.
- `POST /v1/desktop/auth/logout`: bearer access token and `{refreshToken}`; revokes that session, returns `{ok:true}`.
- `POST /v1/desktop/auth/relay-token`: bearer access token and `{relayHostId, hostPublicKeyB64}`; public key is canonical padded base64 of the 32 raw X25519 bytes. `relayHostId` must equal the first 16 characters of base64url(SHA-256(raw key)). Returns `{relayToken, expiresAt}` with expiration in Unix milliseconds.
- `POST /v1/desktop/auth/connector-token`: bearer access token; returns `connector_disabled` (501).
- `GET /.well-known/jwks.json`: ES256 public JWKS with `kid`. `GET /healthz`: `{ok:true}`.

A session object is `{accessToken, refreshToken, expiresAt, cloud, organizations, capabilities}`. `cloud` has `cloudProfileId`, `userId`, `email`, optional `displayName`, and `linkedAt`; organizations is an empty array; capabilities includes `flags` and millisecond `refreshedAt`. Relay JWTs have `sub`, `prof`, `relayHostId`, `purpose=host-control`, `iss`, `aud=orca-relay`, `iat`, and `exp` (seconds); they last five minutes. No `org` is issued.

## Relay configuration

For a ready-made setup, see the [Docker Compose example](../../self-hosted/README.md), which runs this service and a relay behind Caddy.

Build each Dockerfile from the `cloud/` context. Both Docker images were built with Podman 5.4.2 and exercised on a Debian 13 builder (token mint accepted by the relay, tampered token rejected with 401). For a combined relay set `ORCA_RELAY_ROLE=combined`, `ORCA_RELAY_PUBLIC_URL` and `ORCA_RELAY_CELL_URL` to its public HTTPS origin, `ORCA_RELAY_AUTH_ISSUER` to the auth public origin, `ORCA_RELAY_AUTH_AUDIENCE=orca-relay`, `ORCA_RELAY_JWKS_URL` to the auth origin's `/.well-known/jwks.json`, `ORCA_RELAY_ASSIGNMENT_SIGNING_KEY` to a separate random secret of at least 32 characters, `ORCA_RELAY_ADMIN_AUDIENCE` to a URL, `ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT` to an email, `ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED=true`, and `ORCA_RELAY_DATA_DIR` to persistent storage. See the [cloud README](../../README.md) for the relay's other settings.

## Desktop relay end-to-end test

After installing dependencies in the repository root and `cloud/`, run from the root:

```sh
ORCA_BACKGROUND_LAUNCH=1 timeout 900 pnpm run test:e2e:custom-relay
```

The test builds the required cloud packages and E2E desktop, starts the auth service and a combined SQLite relay on loopback, and drives an isolated hidden desktop profile through Settings. It generates a temporary certificate with OpenSSL and puts loopback HTTPS proxies in front of both HTTP services, including WebSocket upgrades; the temporary CA is trusted only by the test processes, with Electron accepting that exact certificate for loopback. This preserves the phone protocol's HTTPS requirement. It checks connection failures and success, sign-in, relay assignment, an encrypted mobile RPC, outage recovery, and switching to a second unreachable local server. The CDP screenshot is written to `.cache/relay-e2e/settings-connected.png`. OpenSSL and Node 24 or newer are required.
