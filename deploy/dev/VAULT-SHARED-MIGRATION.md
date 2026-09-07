# Migrating deploy/dev off its throwaway dev-mode Vault → the shared Vault (172.20.2.21)

> **Status: ✅ DONE (2026-09-07).** This file was written as a forward-looking runbook before
> execution; it's kept as the migration record (what was actually done, in what order, and by
> whom) rather than rewritten into a generic doc — see "What actually happened" below for the
> as-executed sequence, which differs in a few details from the original plan.

## Why

`deploy/dev`'s own `vault` service ran in dev mode (`VAULT_DEV_ROOT_TOKEN_ID`, in-memory
storage) — every host reboot wiped it, requiring `vault-init` to re-run before
`auth-service`/`credential-broker-service` stopped crash-looping. This is exactly what happened
live on 2026-09-06 (a real 172.20.2.39 reboot mid-deploy; `orca-vault-init.service` auto-recovered
it, but the box was degraded for several minutes first). `vnp-domain/vault/` already runs a real,
persistent HashiCorp Vault (`file` storage, real seal/unseal) on `172.20.2.21` for Bifrost —
reusing it removes this whole failure class for Orca.

## What actually happened (as-executed, 2026-09-07)

The shared Vault had **never actually been deployed** (`vnp-domain/vault/docker-compose.yml`
existed as config only — confirmed via `docker ps -a` on 172.20.2.21 showing no vault container
at all) — so this was a first-time bootstrap of that shared instance, not just wiring Orca to an
already-running one:

1. `cd vnp-domain/vault && make deploy-config && make vault-start` — deployed the Vault
   container fresh (`bifrost_vault`, `file` storage backend).
2. `make vault-init` — first attempt failed partway through (real bug in `init-vault.sh`: it
   doesn't check exit codes correctly, so several steps silently no-op'd with "Vault is sealed"
   errors while still printing `✓`) because the auto-unseal step inside it didn't take effect.
   Diagnosed via `make vault-status` (`initialized: true, sealed: true`), fixed with a manual
   `make vault-unseal`, then `make vault-init` re-run to completion — this time it enabled the
   `secret/` KV mount, wrote the `bifrost-app` policy + token, and **revoked the root token**
   (the script's own recommended-and-accepted security prompt).
3. Root token being gone blocked the remaining admin work (enabling new secret engines, writing
   a new policy) — recovered via Vault's own `vault operator generate-root` ceremony (3-of-5
   Shamir unseal keys → a fresh, single-use root token), not by recovering the old one.
4. With that temporary root token: enabled `transit` and `credential-secrets` (kv-v2), applied
   `orca-policy.hcl` (see below — its first draft was missing `create` on `transit/encrypt/*`,
   caught by a live functional test — encrypting against a brand-new key name auto-vivifies it,
   which needs `create` not just `update`; fixed and re-verified), and minted the real
   `orca-backend-go` token now in `deploy/dev/.env`'s `VAULT_TOKEN`.
5. Opened `172.20.2.21`'s firewall for `172.20.2.39` (`sudo ufw allow from 172.20.2.39 to any
   port 8200` — though `ufw` itself turned out to be `inactive` on that host, so this rule alone
   changed nothing; noted as a separate, out-of-scope security-posture gap, not fixed here since
   enabling `ufw` on a host this deploy doesn't own risks locking out its own SSH access if done
   without care).
6. Rebound the Vault container's port from `127.0.0.1:8200:8200` to `0.0.0.0:8200:8200` in
   `vnp-domain/vault/docker-compose.yml`. This needed `docker compose up -d vault`
   (recreate) — a plain `docker compose restart vault` does **not** pick up a changed port
   mapping, only `up`/recreate does; the first attempt at this step used `restart` and silently
   didn't take effect, caught by re-checking `docker port bifrost_vault` before moving on.
   Reseal-then-unseal followed each time, as expected for a `file`-storage Vault restart.
   End-to-end connectivity verified for real: `curl http://172.20.2.21:8200/v1/sys/health` from
   `172.20.2.39` itself (not just from wherever this session's own shell runs).
7. Updated `deploy/dev/docker-compose.yml`: removed the local `vault`/`vault-init` services and
   every `depends_on: vault`/`vault-init` reference (13 + 1 occurrences across the 17 service
   blocks), pointed `x-go-common-env`'s `VAULT_ADDR` at `http://172.20.2.21:8200`, and made
   `VAULT_TOKEN` a hard-required var (`${VAULT_TOKEN:?...}`, no more insecure
   `dev-root-token` default). Validated with `python3 -c "import yaml; yaml.safe_load(...)"` and
   `docker compose config --quiet` before deploying.
8. Fixed `scripts/sync-to-server.sh`, which still referenced the now-removed `vault` service by
   name (`docker compose pull postgres vault nats frontend` / `up -d postgres vault nats`) —
   caught by a real failed deploy (`no such service: vault`) after the compose-file change above,
   not caught by the YAML/config validation in step 7 (those don't know about the deploy
   script's own service-name arguments).
9. Retired `orca-vault-init.service` — the systemd unit that used to re-run `vault-init` after
   every host reboot no longer has a service to re-run against. Disabled it on 172.20.2.39
   (`systemctl disable`) and deleted the unit file from this repo
   (`deploy/dev/systemd/orca-vault-init.service`); see this README's "Vault (shared instance)"
   section for the removal note and the disable command for any other host that still has it
   installed from before this migration.

## The policy — `orca-policy.hcl`

Mirrors `vnp-domain/vault/bifrost-policy.hcl`'s shape but scoped to exactly what
`backend-go/common/secrets` (Transit encrypt/decrypt/sign/verify + `credential-secrets/` KV v2
read/write/destroy-metadata) and `auth-service`'s own direct Transit JWT-signing use (per
`common/secrets/vault.go`'s doc comment: "auth-service is the one other direct Transit caller
... its JWT signing key is a service-wide signing identity") actually touch. No dynamic-DB-
credential paths are included — `backend-go` still falls back to `DATABASE_DSN` for that (no
Vault Agent sidecar wired up yet, confirmed in `vault.go`'s own doc comment), so requesting
broader database-secrets-engine access would be unused scope. Live-verified end to end with the
real orca token: transit encrypt+decrypt round-trip, and credential-secrets KV write+read+
destroy-metadata, all succeed under the policy exactly as scoped.

## Known follow-ups (not done here, deliberately out of scope)

- `ufw` is `inactive` on 172.20.2.21 — the firewall rule added in step 5 has no effect until
  someone enables it properly (with port 22 allowed first, to avoid a self-lockout). Not this
  deploy's host to harden unilaterally.
- The temporary root token used for steps 3-4 should be revoked once nobody else needs it for
  further admin work on the shared Vault — not revoked automatically by this migration, since
  other in-flight work (e.g. Bifrost's own future setup steps) might still need it.
- No mTLS between `172.20.2.39` and `172.20.2.21` — Vault traffic crosses that link in plaintext
  HTTP (TLS is disabled in `vnp-domain/vault/docker-compose.yml`'s listener config). Same
  accepted-tradeoff class as this deploy's other "no mTLS/service mesh" limitation (see README's
  "Known limitations").
