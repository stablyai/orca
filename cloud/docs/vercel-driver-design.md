# Orca Cloud sandboxes on Vercel — white-label driver design (v0)

Status: design + mock-tested code in `nwparker/orca-private` (integration branch `nwparker/vercel-driver`).
Nothing here has touched a real Vercel or Cloudflare resource. Inputs: bake-off (`reports/provider-bakeoff.md`),
`conductor-parity-matrix.html` (Vercel-first, 24h cap), `vm-just-works.html`, `reports/credentials.md`,
stablyai/orca#20777 (recipe that talks to Vercel with the user's own account), billing design
(`cloud/docs/accounts-billing-design.md`).

## Goal and non-goals

- One click "Orca Cloud" workspace. Orca's Vercel Pro team owns every sandbox. Users never see a Vercel account,
  token, dashboard or brand. They pay Orca (billing Worker), and Orca pays Vercel.
- Not in v0: memory pause (Vercel has none), BYO Vercel account (that is #20777's recipe path), live fork, Drives.

## Shape

```
desktop (Electron main)                         Orca sandbox control plane (CF Worker)        Vercel (Orca's team)
 HostedSandboxDriver ──HTTPS, Orca JWT────────▶  /v1/sandboxes/*  ──Vercel token (secret)──▶  /v2/sandboxes/*
   implements EnvironmentProviderDriver           D1: sandboxes, sessions, usage cursor         persistent sandbox
   └ recipe adapter → existing runtime record     billing: /v1/internal/entitlements/check,     per workspace,
     / pairing / resume pipeline                    /v1/internal/usage (CONTROL_PLANE_TOKEN)    golden snapshot
 desktop ◀───────── wss pairing (orcad, E2EE) ─────────────────────────────────────────────▶  orcad :6768
```

- **Control plane = Cloudflare Worker + D1** (`cloud/apps/sandbox-control`). Same stack as billing and relay-edge,
  so one toolchain, JWKS auth pattern and deploy story. It is the only holder of `VERCEL_TOKEN`/team/project.
  Workers can't run `@vercel/sandbox` (undici, fs, xdg paths), so the Worker calls Vercel's REST API (`/v2`, `/v3`
  endpoints read from SDK 3.9.1's api-client) through a `SandboxProviderApi` interface. Tests use an in-memory fake;
  the REST client is tested against a fake `fetch`. A Durable Object per sandbox is the upgrade path if D1
  conditional updates prove too weak for concurrent lifecycle calls (v0 uses a `generation` compare-and-set).
- **Desktop** holds only a short-lived Orca JWT (`aud=orca-sandbox`, minted by Orca Cloud auth like the billing
  token; until that endpoint exists the token provider is injected). It never sees a Vercel credential.
- **Integration with existing VM code**: the hosted driver returns the same `orca-server` recipe result
  (`pairingCode`, `projectRoot`, `userData`) a shell recipe prints, so write-ahead records (#39241), timeouts
  (#39238), pairing reuse on resume (#39225), host health and sleep/wake work unchanged. The adapter lives in
  `src/main/environment-providers/environment-provider-recipe-adapter.ts`; recipe catalog/UI wiring is follow-up.

## Desktop interface (`src/main/environment-providers/`)

`EnvironmentProviderDriver`: `create(spec)`, `resume(handle)`, `suspend(handle)`, `destroy(handle)`,
`status(handle)`, optional `renewLease(handle, ms)` and `rollover(handle)`; every call takes
`{signal, onProgress(phase)}`. Handles are `{driverId, environmentId, driverState}` (opaque JSON persisted in the
runtime record's `userData`). Capability flags drive UX and schedulers:

| flag | Vercel hosted |
|---|---|
| `memoryPause` | false (stop = reboot, PTYs lost; measured) |
| `maxSessionMs` | 24h (Pro). Scheduler forces rollover at 23h50m |
| `fsPersistOnStop` | true (auto snapshot on stop, keepLastSnapshots 2) |
| `egressInjection` | true |
| `idleStopMs` | 20 min default (Orca-owned, not Vercel's timeout) |

Errors are `EnvironmentProviderError{code}` with a closed code set (`entitlement_denied:<reason>`,
`not_found`, `conflict`, `unavailable`, `timeout`, `unauthorized`, `invalid_response`). A driver contract kit
(`environment-provider-driver-contract.ts`) runs the lifecycle against any driver; the hosted driver runs it
against a fake control plane.

## Control-plane API (Worker)

All desktop routes require the Orca JWT; the account is `org:<id>` or `user:<id>` (same rule as billing).

| route | does |
|---|---|
| `POST /v1/sandboxes {workspaceId, machineSize, region?, repo?}` | entitlement check → write-ahead row → create from golden snapshot → start orcad → `{sandbox, connection, session}` |
| `GET /v1/sandboxes[/:id]` | status from D1 + provider reconcile |
| `POST /v1/sandboxes/:id/suspend` | drain orcad → stop session (auto snapshot) → settle usage |
| `POST /v1/sandboxes/:id/resume` | entitlement check → resume → start orcad → connection (same pairing; identity on disk) |
| `POST /v1/sandboxes/:id/lease {extendMs}` | `extend-timeout`, clamped to the session deadline |
| `POST /v1/sandboxes/:id/rollover` | drain → stop → resume → start orcad (24h cap path) |
| `DELETE /v1/sandboxes/:id` | delete with `deleteOrphanSnapshots`, then verify every recorded snapshot is gone |
| `POST /v1/egress/proxy` | Vercel `forwardURL` target (see egress) |
| cron (5 min) | settle usage, stop sandboxes past idle/deadline or whose account lost entitlement, sweep stuck `creating` rows |

Vercel resource naming: `orca-<sandboxId>` where `sandboxId` is our random id (never user text). Tags: `orcaSandbox`,
`orcaEnv` (prod/dev). Ownership is checked against D1 + the name; nothing is ever deleted by prefix.
Create params: `source: {type:'snapshot', snapshotId: GOLDEN_SNAPSHOT_ID}`, `persistent: true`,
`ports: [6768]`, `resources.vcpus` from machine size (standard 4, large 8; xlarge 16 needs Enterprise),
`timeout` = Orca lease (30 min, renewed), `keepLastSnapshots: {count: 2}`, `snapshotExpiration: 0` while live
(finite TTL after archive), `region` default `iad1`, `networkPolicy` from the policy compiler.

**Entitlements**: `POST billing /v1/internal/entitlements/check {accountId, machineSize, runningSandboxes}` before
create/resume. If billing is unreachable or unconfigured the Worker refuses (fail closed); a stub client is used only
when `ENTITLEMENTS_MODE=stub` in local dev. **Usage**: per-session segments `[lastSettledAt, now]` (≤24h) sent to
`/v1/internal/usage` with `usageId = <sandboxId>:<sessionId>:<segmentStart>` (idempotent). If the answer says new
starts are no longer allowed for `included_hours_exhausted`/`overage_cap_reached`, running sandboxes are drained and
stopped; `payment_past_due` keeps running (grace is an open billing decision).

**Pairing material**: the Worker runs `orca-sandbox-start` in the VM and returns orcad's ready JSON
(`pairingCode`, `projectRoot`). Pairing codes are never logged or stored in D1. v1 hardening: the desktop sends a
device public key and the VM pre-authorizes it, so the control plane never carries a usable pairing secret.
Endpoint branding: v0 dials the `*.vercel.run` route internally (not shown in UI); v1 fronts it with
`*.sandbox.onorca.dev` if white-label needs to extend to network inspection.

## Golden image (`cloud/apps/sandbox-control/image/`)

Operator-only script (`build-golden-image.ts`, dry-run by default). Steps: create build sandbox (`node24`, 4 vCPU,
non-persistent, 40 min) → upload pinned orcad linux-x64 bundle (sha256-checked) → `provision-golden.sh`: apt
basics, `gh`, pinned agent CLIs (Claude Code, Codex, OpenCode, Gemini), git credential helper + `orca-sandbox-start`,
`orca-sandbox-drain`, `orca-egress-probe` → smoke (orcad reaches ready, CLIs `--version`) → **wipe orcad identity and
any auth homes** (clone-safe, risk #1) → snapshot with `expiration: 0` → delete build sandbox → print manifest
(`snapshotId`, versions, sha256) for `GOLDEN_SNAPSHOT_ID`. Snapshot → orcad ready measured at 3.3–4.3s.

## Network policy (fail closed)

Compiled per sandbox by `compileNetworkPolicy()`:
- Allowlist record form, **no `"*"` entry** (unlisted domains don't resolve). Default list: package registries
  (npm, pypi, crates, go proxy, rubygems), github.com + codeload + objects, agent APIs (Anthropic, OpenAI/ChatGPT,
  Google), and Orca endpoints. Workspaces can opt into `"open"` (adds `"*": []`), never silently.
- Credential hosts get `[...inject rules, {response: 403 orca-egress-denied}]`: a request without our placeholder is
  refused, so the real token can't be paired with an attacker-chosen request shape.
- GitHub: VM sets `http.https://github.com/.extraheader = Authorization: Basic b64(x-access-token:<placeholder>)` so
  every git request carries the placeholder (git otherwise sends an unauthenticated probe first, which the trailing
  deny would 403). The control plane mints a 1h GitHub App installation token and rewrites the policy before expiry.
- **Node fetch hang**: with a `transform` rule, the Vercel proxy answers HTTP/1.1 with no `content-length` or
  `transfer-encoding`; undici waits forever. curl/git (libcurl) and Go (`gh`) are fine. Handling: (1) `transform` is
  used only for hosts whose clients are curl/Go (github.com git traffic); (2) hosts Node clients use
  (api.github.com) get a `forwardURL` rule to `POST /v1/egress/proxy` on the control plane instead, which verifies
  Vercel's sandbox OIDC token (`oidc.vercel.com`, aud = forward URL), maps `sandbox_name` → our row, injects the
  header and returns a normally framed response — this also keeps users' GitHub tokens out of Vercel's policy store;
  (3) the image ships `orca-egress-probe` that does a bounded Node `fetch` per credential host at boot and reports
  `egress_framing_hang` instead of letting agents hang. File the framing bug with Vercel. Needs a live test.
- Agent sign-in is native inside the VM (unmodified CLI, Anthropic-compliant); model hosts are allowlisted, not
  injected. Auth homes live on the sandbox disk and persist across stop/resume.

## Lifecycle, idle stop and the 24h cap

- One persistent sandbox per workspace. Orca owns the timer: Vercel `timeout` is a 30 min lease that the desktop
  renews while orcad reports busy; if the desktop disappears the lease lapses and Vercel stops the session (files kept).
- Idle stop: 20 min without clients, agents or PTY input → suspend.
- Opportunistic rollover after ~12h when all agents idle and PTYs quiet ≥2 min. Forced rollover at 23h50m: warn at
  T−60 and T−15, stop admitting turns at T−10, drain (orcad SIGTERM → durable restart offers, scrollback/cwd hints)
  up to 5 min, stop, resume, start orcad. One state machine covers idle stop, cap, crash and "Restart".
- After reconnect the desktop auto-continues the durable offers (`agentSession.restartResumable` →
  `agentSession.restartContinue`) for sessions the rollover interrupted, so agents carry on without user action.

## Failure / leak handling

- Write-ahead D1 row before any Vercel call; the deterministic name makes create retries idempotent (`GET` by name
  first). Cron reconciles rows stuck in `creating`/`destroying`.
- Destroy deletes the sandbox with `deleteOrphanSnapshots=true`, then lists snapshots by name and deletes any left
  (bake-off: ~325 MB auto snapshots survive delete otherwise).
- Vercel errors map to catalogued codes; bodies are never echoed to the desktop.

## Security

- Secrets via `wrangler secret put` only: `VERCEL_TOKEN` (team-scoped, Sandbox only), `CONTROL_PLANE_TOKEN`,
  `GITHUB_APP_PRIVATE_KEY`. Worker refuses to start lifecycle routes if `VERCEL_TEAM_ID`/`VERCEL_PROJECT_ID` are
  missing. No routes / `workers_dev:false` in the checked-in wrangler file.
- Per-account authorization on every route (row `account_id` must equal the caller's); ids are random.
- Strict zod bodies, 16 KiB limit, no redirects on provider calls, provider error bodies dropped.

GitHub App + billing dev (2026-11-09): app "Orca Cloud (dev)" (stablyai, id 5677658,
https://github.com/apps/orca-cloud-dev; contents/pull_requests write, metadata read, no webhook) created by the
manifest flow; key only as a Worker secret. From a real sandbox via the dev Worker: private repo cloned at create
(6.6s total), real `git push` of a new branch in 1.0s with the transform-injected repo token, `gh` and Node fetch to
api.github.com through the forwardURL proxy with a minted token (200, ~1s), no token on the VM disk. Billing dev is
reached over a service binding (same-account workers.dev fetches fail with 1042): an account without a subscription
gets 403 `no_subscription`; the cron's suspensions poll runs clean. `dev:*` operator accounts bypass billing outside prod.

Desktop dogfood (2026-11-09, dev app → dev Worker → Vercel Pro): "Orca Cloud" is a built-in provider in Run on
(reserved id `cloud`); create → orcad ready in the app 8–12s with the private repo cloned via the GitHub App; shell
work + real `git push` from the cloud workspace; 15-min cap warning toast; forced rollover at the (shortened) cap
with reconnect and files kept; idle sleep through the ordinary Sleep flow after a (shortened) 2-min idle; wake on
click; destroy through runtime cleanup leaves no sandbox or snapshot. Found live and fixed: agent hosts must be
wildcard-allowlisted (platform.claude.com), the runtime store dropped `provider` (now in the feature store), remote
keystrokes are not 'driving' input (verdict reads all input), Vercel answers 400 when deleting an
already-deleted snapshot. Not run: agent auto-resume with a real chat (needs a Claude/Codex sign-in).

## Built (mock-tested) and next wiring

- (b) `src/main/environment-providers/*`, `src/main/hosted-sandbox/*` — driver, client, contract kit, recipe adapter.
- (c) `cloud/apps/sandbox-control` — Worker, D1 schema, Vercel REST client, entitlements/usage, egress proxy, cron.
- (d) `cloud/apps/sandbox-control/image` — golden image builder + VM entry points.
- (e) `hosted-session-lease-policy.ts` / `-scheduler.ts` / `hosted-agent-auto-resume.ts` — lease renew, T−60/T−15
  warnings, idle suspend, opportunistic + forced rollover, then `restartResumable` → `restartContinue` for offers
  recorded since the drain (older offers stay with the user). The cron only force-stops 5 min after the deadline.
- Next: a built-in "Orca Cloud" recipe source whose create/resume/suspend/destroy call the driver through the
  recipe adapter; start one scheduler per ready hosted runtime (stop on suspend/destroy); an orcad RPC exposing
  the idle-probe verdict + last PTY input for `readActivity`; header warning + mobile push for `warn`.

## Live results (2026-11-09, Vercel Pro team `lovecast`, project `orca-sandbox-control`, iad1)

Driven by the real Worker handler in-process (real Vercel REST, node:sqlite D1, stub billing) and the real desktop
driver/scheduler. Base OS is Amazon Linux 2023 (dnf), not Ubuntu.
- Golden image: orcad built from public stablyai/orca@7c14832 in a 8 vCPU build sandbox in 98s (67 MB tgz);
  provision 14.3s (gh 2.103.3, Claude Code 2.1.319, Codex 0.166.0; orcad loopback smoke passed); wipe ok;
  snapshot 8.2s. Bug found and fixed: provision downloaded the bundle over its own source path.
- Snapshot → orcad ready (`POST /v1/sandboxes`, incl. Vercel create + orca-sandbox-start): 5.4 / 4.1 / 4.9 s; WS open.
- Suspend (drain + stop) 7.6s; resume → ready 6.0s; same endpoint and same orcad host key (no re-pair).
- Shortened cap (6 min): scheduler warned T−15, then forced rollover at the deadline in 17.3s (drain, stop, boot,
  orcad ready), reconnect WS open, new deadline set. Destroy 0.4–0.7s; zero sandboxes/snapshots left.
- Egress: allowlist resolves npm (200), `example.com` does not resolve (curl rc 6). Policy update 0.25s.
  Placeholder → injected fake GitHub credential reaches GitHub (curl/gh `token` scheme: 401 Bad credentials);
  attacker token and placeholder-less git → 403 `orca-egress-denied`. Node fetch under a transform rule still hangs
  on Pro; `orca-egress-probe` reports `egress_framing_hang` (npm, untransformed: ok). No real GitHub token was used,
  so a successful authenticated push is still unverified.
- Not covered live: agent auto-resume with a real chat (needs a real Claude/Codex sign-in).

Dev deployment (2026-11-09): Worker https://orca-sandbox-control-dev.lovecast.workers.dev, D1
`orca-sandbox-control-dev`, config `wrangler.dev.jsonc`, billing stubbed (no billing dev Worker yet). Through it:
create 5.1s, rollover 12.2s (same host key), destroy 1.0s, no snapshots left. Egress proxy end to end from a real
sandbox: Bearer and gh `token` placeholders forwarded and re-injected (GitHub answers the injected fake: 401), Node
fetch completes in 450 ms with chunked framing (the transform-rule hang is gone), attacker token / no auth → 403.

## Secret store and injection (org / personal / repo)

Product decision: "API-key injection" in the Conductor parity matrix (form 2 = this store; form 3 = egress swap).
- **Store** (`src/secrets.ts`, migration 0003): D1 `secrets` keyed (scope, owner_id, name). Envelope encryption
  (`src/secrets-crypto.ts`): per-secret random AES-256-GCM DEK; DEK wrapped by the KEK (`SECRETS_KEK`, base64 32
  bytes, Worker secret only; id `SECRETS_KEK_ID`, default `k1`). Both layers take `["orca-secret-v1", layer, kekId,
  scope, ownerId, name]` as AAD, so a row copied onto another owner/name fails to open (skipped at injection,
  logged by name). Rotation: set the new KEK + id, move the old one into `SECRETS_KEK_RETIRED` (`{"k1":"…"}`); rows
  re-seal on their next write.
- **API** (desktop JWT): `GET /v1/secrets?scope=org|personal|repo[&repo=owner/name]`, `PUT /v1/secrets/:scope/:NAME`
  `{value}`, `DELETE …`. Write-only values: responses carry name, scope, kind, updatedAt, updatedBy and a last-4 hint
  for values ≥16 chars. Owners: org = the org account (`org:<id>`), personal = `user:<sub>`, repo =
  `<account>#github.com/<owner>/<repo>`. Org secrets and an org account's repo secrets need `orgRole` owner/admin on
  the token (any member lists names); personal secrets are the user's alone; dev tokens stay under `dev:`.
- **Validation**: `^[A-Z_][A-Z0-9_]*$` ≤128; reserved names (PATH, HOME, NODE_OPTIONS, proxy/CA vars, GIT_SSH*,
  GH_TOKEN/GITHUB_TOKEN, …) and prefixes (LD_, DYLD_, ORCA_, VERCEL_, BASH_FUNC_, GIT_CONFIG). Values ≤8 KiB, no NUL;
  100 secrets per owner; 128 KiB injected per start. **Never stored**: `CLAUDE_CODE_OAUTH_TOKEN`, any value starting
  `sk-ant-oat`, JWT-shaped `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` (ChatGPT/Claude.ai sessions).
- **Precedence**: env secrets repo > personal > org; agent keys (ANTHROPIC/OPENAI/GEMINI/GOOGLE/CURSOR keys, AWS
  Bedrock and Vertex vars) org-shared > repo > personal. Per name, so a partial org Bedrock set mixes with personal.
- **Injection**: every boot (create, resume, rollover) resolves secrets and passes them to `orca-sandbox-start` as
  `ORCA_SECRET_ENV` (`NAME=<base64>` lines). The script decodes them into orcad's `env -i` launch env (agents inherit
  it) through a pipe, unsets the variable, and writes nothing to disk, so the stop snapshot never holds them and
  `orca-image-wipe` has nothing to wipe. Edits apply on the next start/resume, no image rebuild. Values transit
  Vercel's command API (as the VM's env would anyway); logs carry counts and names only.
- **Phase 2 egress swap** (`src/secret-egress.ts`, `SECRETS_EGRESS_PLACEHOLDERS=on`, off by default): VM env gets
  `orca-ph-anthropic-<sbx>` / `orca-ph-openai-<sbx>`; boot records the hosts on the row (`egress_secret_hosts`) and
  the policy gets forwardURL claims (`api.anthropic.com`: `x-api-key: <ph>` and `Authorization: Bearer <ph>`;
  `api.openai.com`: `Authorization: Bearer <ph>`) followed by the 403 deny. The egress proxy (OIDC-verified, as for
  api.github.com) swaps in the real key, cached per session for 60 s. Transform rules are not used: they hang Node
  clients (Claude Code, Codex), the forwardURL path is the one proven live for api.github.com. Not on by default
  because (1) SSE model streams through Vercel forwardURL → Worker are not yet tested live, and (2) with a key routed,
  api.anthropic.com denies everything else, including a subscription OAuth Bearer or a plain `ANTHROPIC_AUTH_TOKEN`
  in the same VM. Enable on dev after a live streaming test with the rebuilt image.
- Needs: golden image rebuild (new `orca-sandbox-start`), and Orca Cloud auth minting `orgRole` on sandbox tokens (stablyai/orca-cloud#695).

## GitHub installation binding, guardrails, retention (2026-11-09)

- Repo tokens need a binding: `github_installations(installation_id, account_id)`. `tokenForRepo(url, accountId)`
  looks up the repo's installation, refuses unless the caller's account holds a live binding (re-checked on cached
  tokens too), mints for that one repo (contents/pull_requests write, metadata read) and rejects a wider response.
  Binding: desktop `POST /v1/github/connect` → signed (HMAC), single-use, 10-min state carrying the Orca account →
  GitHub install / OAuth → `/v1/github/setup` + `/v1/github/callback` exchange the code for a user-to-server token and
  bind only installations on the GitHub user's own account or on an org where they are an active admin
  (`/user/memberships/orgs`, needs the app's Members:read). Installation ids in URLs are never trusted.
  Operator binding for support/dev: `POST /v1/internal/github/bindings {installationId|repoUrl, accountId}`.
- Guardrails before billing: kill switch (D1 flag via `POST /v1/internal/kill-switch`, or `SANDBOX_CREATES_DISABLED`)
  refuses create/resume/rollover with 503 `maintenance` and drains running sandboxes (suspend, snapshot kept; cron
  keeps draining while on); global `SANDBOX_MAX_RUNNING` (50, 503 `capacity`); per-account 3 × seats backstop
  (403 `concurrency_limit`); `CREATE_RATE_PER_MINUTE` (10, 429).
- Hourly housekeeping: provider sandboxes tagged with this env and no live row are stopped on first sight and
  deleted after `ORPHAN_GRACE_HOURS` (24); automatic snapshots whose sandbox no longer exists anywhere in the project
  are deleted after the same grace (manual/golden never; partial listings delete nothing). Canceled/unpaid accounts
  (suspensions list + daily standing probe; outages never start a clock) get a warning hook at T−7 days and are
  destroyed `DATA_RETENTION_DAYS` (30) after; suspended sandboxes idle `IDLE_RETENTION_DAYS` (90) likewise. New
  sandboxes set `snapshotExpiration` to 104 days (backstop). Destroyed rows drop `repo_url`.
- Live on dev: unbound account → private clone refused (no token minted); after operator binding → clone + push +
  gh/Node via proxy OK; kill switch drill drained 1, refused create/resume, resume OK after lifting.

## What needs live access (not done)

Vercel Pro team id + project id + a Sandbox-scoped token (as Worker secrets), wrangler auth for a dev D1, a
billing Worker dev deployment + `CONTROL_PLANE_TOKEN`, and an Orca Cloud auth change to mint `aud=orca-sandbox`
tokens. Live checks then: golden image build, snapshot→ready timing on Pro, forwardURL + OIDC proxy, Basic-auth
inject for git, 24h rollover rehearsal with a shortened cap.
