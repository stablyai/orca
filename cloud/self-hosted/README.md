# Self-hosted relay with Docker Compose

An example that runs the relay, the sign-in service ([`relay-auth`](../apps/relay-auth/README.md)) and [Caddy](https://caddyserver.com) on one machine. Caddy gets a Let's Encrypt certificate and serves both on one HTTPS origin:

- `/v1/desktop/auth/*`, `/.well-known/jwks.json` and `/healthz` go to `relay-auth`.
- `/v1/admin` returns 404. The relay's admin API is for the hosted deployment.
- Everything else, including WebSockets, goes to the relay.

The relay runs in `combined` mode (director and cell in one process) with SQLite. Phone traffic is end-to-end encrypted between phone and desktop, so the relay only forwards opaque frames.

## Run it

You need a machine with Docker Compose, a DNS name pointing at it, and ports 80 and 443 open.

```sh
cd cloud/self-hosted
cp .env.example .env   # then fill in the domain, email and two secrets
docker compose up -d --build
```

Check it with `curl https://orca.example.com/healthz`.

In Orca, open **Settings → Mobile → Custom relay server**, turn it on and set:

- **Auth server URL:** `https://orca.example.com`
- **Client ID:** `orca-desktop`
- **Relay director URL:** `https://orca.example.com`

Press **Test connection**, then **Apply changes**, and sign in with the admin secret from `.env`. Pair your phone as usual from **Settings → Mobile**.

## Sign in with your identity provider

By default one administrator signs in with `ORCA_AUTH_ADMIN_SECRET`. To use an OIDC provider (Zitadel, Keycloak, Authentik and so on), uncomment the `ORCA_AUTH_UPSTREAM_*` lines in `compose.yaml` and follow [Upstream OIDC](../apps/relay-auth/README.md#upstream-oidc-zitadel). The provider runs separately; it is not part of this example.

## Data and upgrades

State lives in named volumes. `auth-data` holds the sign-in database and the token signing key. `relay-data` holds the relay's SQLite database. `caddy-data` holds certificates. Back up `auth-data`: losing its signing key signs every desktop out. To upgrade, pull the repository and run `docker compose up -d --build` again.

## Trying it without a public name

Set `ORCA_TLS=internal`, a domain with a port such as `ORCA_DOMAIN=localhost:8443`, and `ORCA_HTTPS_PORT=8443` (see `.env.example`). Caddy then uses its own certificate authority. Phones and packaged desktop builds don't trust it, so this mode is only for checking the services; real use needs a publicly trusted certificate.
