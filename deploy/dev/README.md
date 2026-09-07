# Orca Dev Server — backend-go + frontend

> This directory now deploys **`backend-go/`** (17 Go microservices) +
> **`frontend/`**. The previous TypeScript-backend deploy set that used to
> live here has moved to [`deploy/old/`](../old/README.md) — it's untouched
> and still works, kept as a reference / rollback path while `backend-go/`
> is a scaffold (see [`backend-go/docs/execution-plan.md`](../../backend-go/docs/execution-plan.md)
> for what "scaffold" means concretely). Deploy Agent (Dev Server Agent),
> Desktop, and Mobile are unaffected — see `deploy/agent/`, `deploy/desktop/`,
> `deploy/mobile/`.

## The flow

```
[Máy Developer / CI]                              [Orca Server]
──────────────────────                            ─────────────────────────────────
1. build-local.sh                                  4. docker compose pull (public images
   → cross-compile 17 Go binaries                     only — nothing custom-built)
     (CGO_ENABLED=0, linux/amd64)                   5. migrate.sh --remote (one-shot
   → vite build frontend/                              migrate/migrate containers, profile
                                                        "migrate")
2. sync-to-server.sh <version>                      6. docker compose up -d
   → rsync binaries + migrations +                     ┌──────────────────────────────┐
     frontend build + deploy config                    │ 17 backend-go containers      │
     (NOT source — backend-go/ source                  │  gcr.io/distroless/static     │ ← binary
     never touches the server)                         │  (~2MB, no shell) + BIND-      │   bind-
                                                         │  MOUNTED binary, read-only     │   mounted
                                                         │ frontend (nginx:alpine) +      │ ← static
                                                         │  BIND-MOUNTED dist/            │   assets
                                                         │ postgres / vault / nats        │   mounted
                                                         └──────────────────────────────┘
3. (sync-to-server.sh calls the above for you)
```

**No image is built for backend-go or the frontend at all** — every
container runs a stock public image
(`gcr.io/distroless/static-debian12:nonroot` for all 17 Go services,
`nginx:1.27-alpine` for the frontend) with the locally-built binary /
static bundle **bind-mounted** in read-only. This is the literal
"smallest possible image" answer: there's no smaller option than not
building a custom one. See `docker-compose.yml`'s header comment for the
full rationale.

## Structure

```
deploy/dev/
├── docker-compose.yml           # postgres, nats, 17 backend-go services, frontend, 14 migrate-* one-shots (Vault is external — see below)
├── .env.example / .env          # config (backend-go + frontend only — agent config is deploy/agent/.env.example)
├── orca-policy.hcl              # Vault policy applied to the SHARED vnp-domain Vault (172.20.2.21), not run by this compose file
├── VAULT-SHARED-MIGRATION.md    # migration record: throwaway local Vault -> shared persistent Vault
├── docker/
│   ├── postgres/init-databases.sh   # creates the 14 per-service databases on first boot
│   └── nginx/orca.conf              # frontend: serves the SPA + reverse-proxies /v1/* to api-gateway
└── scripts/
    ├── build-local.sh           # [LOCAL] cross-compile all 17 Go binaries + vite-build frontend
    ├── sync-to-server.sh        # [LOCAL] build, rsync, pull images, migrate, up -d — the whole flow in one command
    └── migrate.sh               # [LOCAL or --remote] run golang-migrate for one/all services
```

## Quick start

```bash
cd /path/to/orca

# 1. Config
cp deploy/dev/.env.example deploy/dev/.env
nano deploy/dev/.env    # set POSTGRES_PASSWORD, SERVER_HOST, SERVER_KEY

# 2. Deploy (builds locally, syncs, migrates, starts)
bash deploy/dev/scripts/sync-to-server.sh 0.1.0
```

### Local-only (no remote server — test the stack on your own machine)

```bash
cp deploy/dev/.env.example deploy/dev/.env   # POSTGRES_PASSWORD is enough locally
bash deploy/dev/scripts/build-local.sh
cd deploy/dev
docker compose up -d postgres vault nats
../../deploy/dev/scripts/migrate.sh
docker compose up -d
```

### Redeploy after a code change

```bash
bash deploy/dev/scripts/sync-to-server.sh 0.1.1   # any changed services' binaries + frontend
```

Every run rebuilds and re-syncs **all** 17 services' binaries — cheap
(static Go builds, seconds each) compared to the old Node/Vite flow, so
there's no per-service incremental-build machinery here. If that stops
being true at some point (build time becomes a real bottleneck),
`build-local.sh <service-name>` already supports building one service only
— wire that into `sync-to-server.sh` as an optional argument then.

## Networking

- Only **`frontend`** (nginx, port `FRONTEND_HTTP_PORT`, default 8080) and
  **`api-gateway`** (port `API_GATEWAY_PUBLIC_PORT`, default 8081) are
  exposed to the host. Every other service is reachable only on the
  internal `orca-go-net` bridge network, per
  [`specs/backend-go/architecture/08-inter-service-communication.md`](../../specs/backend-go/architecture/08-inter-service-communication.md).
- The frontend nginx config proxies `/v1/*` (REST) and
  `/v1/notifications/stream` (WebSocket) to `api-gateway` — the browser
  never talks to an individual backend-go service directly.
- TLS termination is **not** handled by either container here — it's
  expected to sit in front of `frontend` at the host/gateway level (same
  layering `deploy/old/gateway/` used). Add it there, or put a TLS-terminating
  proxy in this compose file, once this deploy needs to be reachable outside
  a trusted network.

## Known limitations (read before treating this as production)

- **Vault is the shared, persistent vnp-domain instance (172.20.2.21), not a
  local dev-mode container** (as of 2026-09-07 — see
  [`VAULT-SHARED-MIGRATION.md`](./VAULT-SHARED-MIGRATION.md) for the
  migration record and [`orca-policy.hcl`](./orca-policy.hcl) for exactly
  what's granted). This replaced the original throwaway dev-mode Vault
  (`VAULT_DEV_ROOT_TOKEN_ID`, in-memory, wiped on every restart) after a real
  incident: a 172.20.2.39 reboot wiped it, and `auth-service`/
  `credential-broker-service` crash-looped until manual recovery. The shared
  instance uses `file` storage (persists across restarts) and requires
  `VAULT_TOKEN` in `.env` to be set to the real orca-scoped token — there is
  no insecure default anymore (`docker compose up` fails loudly if unset,
  see `x-go-common-env` in docker-compose.yml). This is still not the full
  HA/auto-unseal setup
  [`specs/backend-go/architecture/06-secrets-vault-architecture.md`](../../specs/backend-go/architecture/06-secrets-vault-architecture.md)
  specifies for real production, but it no longer loses data on reboot.
- **No mTLS / service mesh** — containers talk to each other in plaintext
  over the `orca-go-net` bridge network. `architecture/07-security-architecture.md`
  specifies mTLS via a service mesh for production; this Docker Compose
  deploy has no mesh at all (that's a Kubernetes-shaped concern, not a
  Compose one — see `specs/backend-go/architecture/10-deployment-infrastructure.md`
  for the Kubernetes target this eventually graduates to).
- **`read_only: true` on every backend-go container** — distroless images
  have no writable layer need for a stateless-by-design Go service, but if
  a future service genuinely needs to write local scratch files, add a
  `tmpfs:` mount for that path rather than flipping `read_only` off
  wholesale.
- **Every backend-go service in this repository is itself a scaffold** —
  several cross-service calls are stubs (see each service's own README and
  [`backend-go/docs/execution-plan.md`](../../backend-go/docs/execution-plan.md)).
  This deploy set makes the *infrastructure* real; it doesn't make the
  *application* feature-complete.
- **SSO (CR-LOGIN-001) is off by default and single-tenant-only when on.**
  Every `SSO_*`/`AUTH_MODE`/`PUBLIC_BASE_URL` var in `.env.example` is
  optional — leaving them unset keeps local-password login working exactly
  as before. Turning SSO on requires `PUBLIC_BASE_URL` to be this
  deployment's real externally-reachable URL (never guessed from a request)
  and each configured provider's redirect URI registered to match it
  exactly. A brand-new SSO user's tenant is auto-resolved only when exactly
  one company/tenant exists in this deployment — see
  `backend-go/services/auth-service/README.md`'s SSO entry for the full
  account-linking policy and remaining known gaps.

## Vault (shared instance) — no local re-init needed anymore

Orca's own `vault`/`vault-init` services and the `orca-vault-init.service`
systemd unit that used to recover them after a host reboot are **gone**
(removed 2026-09-07, see `VAULT-SHARED-MIGRATION.md`) — there is nothing
local to re-initialize on this host anymore. The shared Vault at
172.20.2.21 is a separate, persistent instance managed by whoever owns
`vnp-domain/vault/`; if IT is ever sealed (its own host reboot, an operator
action), `deploy/dev`'s services will fail closed against it (transit/
credential-secrets calls error) until someone runs `vault-unseal` **over
there** — that recovery is out of this deploy's scope, same as any other
shared dependency this deploy doesn't own (see vnp-domain/vault/README.md).

If `orca-vault-init.service` is still installed/enabled on an older host
from before this migration, disable it — it references a `vault-init`
compose service that no longer exists and will fail on the next boot:
```bash
sudo systemctl disable --now orca-vault-init.service
sudo rm -f /etc/systemd/system/orca-vault-init.service
sudo systemctl daemon-reload
```
