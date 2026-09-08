# BUG-010: 6 of 10 `onboarding.*` channels not implemented in backend-go

**Correction (2026-09-07 re-verification):** the original title/count here said "6 of 9" — off by one. The frontend calls exactly 10 distinct `onboarding.*` methods (`get`, `update`, `markChecklistItem`, `detectAgents`, plus the 6 listed below), confirmed via `grep -c "^onboarding\." frontend_rpc_methods.txt` → `10`. 4 are registered, 6 are missing — the 6-missing count and every other claim in this report were already correct; only the "of 9" denominator was wrong.

**Service:** `api-gateway` (WS compat layer) / dev-server Agent (`preflight.*` RPCs, already exist)
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go`
**Severity:** Resolved — all 6 originally-missing channels are now implemented (see
**Update (2026-09-07)** below); core onboarding-state persistence
(`get`/`update`/`markChecklistItem`) already worked before this bug.
**Status:** Closed — 6/6 resolved (TASK-027/TASK-028/TASK-029/TASK-030)

**Update (2026-09-07):** `onboarding.openGhAuthTerminal`, the 6th and last missing channel,
shipped under TASK-030 (`specs/backend-go/bugs/missing-v3/tasks/TASK-030-onboarding-open-gh-auth-terminal-blocked.md`).
It was previously marked blocked on TASK-022's `environmentId` resolution via an
over-conservative dependency check; re-verified against the real desktop precedent
(`desktop/src/main/ipc/onboarding-ipc.ts:214-229`) that this RPC is keyed by a concrete
`devServerId` the caller already holds, not a bare `environmentId`, so it only needed
`terminal.create`'s connection-bound spawn path (landed, TASK-019–021), not TASK-022 at all.
6 of 6 originally-missing `onboarding.*` channels are now resolved — this bug is closed.

---

## What's registered today

`registerOnboardingChannels` (`channels_onboarding.go:156-235`) registers exactly 4 channels:
`onboarding.get`, `onboarding.update`, `onboarding.markChecklistItem`,
`onboarding.detectAgents`. Re-verified against a fresh scan of `wscompat/*.go`'s
`.Register("...")` calls — no dynamic/loop registration hides any more `onboarding.*`
channels (unlike `browser.*`, see BUG-009).

## What's missing

The frontend's `runtime-onboarding-client.ts` calls 6 more methods when
`target.kind === 'environment'` (i.e., against a remote/backend-go-backed runtime), none of
which have a `wscompat` handler and therefore fall through to `notImplementedHandler`:

| Method | Frontend call site | Agent RPC it needs |
|---|---|---|
| `onboarding.detectAgentsAllServers` | `runtime-onboarding-client.ts:64-72` | fan-out of `preflight.detectAgents` across every known dev server (no single RPC — an orchestration loop) |
| `onboarding.getPreflightStatus` | `runtime-onboarding-client.ts:74-83` | `preflight.check` (Contract B — the real gh/glab/git install+auth+identity probe, `specs/agent/api/agent-rpc-catalog-runtime.md:197`) |
| `onboarding.setGitIdentity` | `runtime-onboarding-client.ts:85-95` | `preflight.setGitIdentity` (`agent-rpc-catalog-runtime.md:199`) |
| `onboarding.detectGhosttyConfig` | `runtime-onboarding-client.ts:97-106` | `preflight.detectGhosttyConfig` (`agent-rpc-catalog-runtime.md:195`) |
| `onboarding.openGhAuthTerminal` | `runtime-onboarding-client.ts:108-117` | needs to spawn a PTY running `gh auth login` on the dev server |
| `onboarding.detectWindowsCapabilities` | `runtime-onboarding-client.ts:119-128` | `preflight.detectWindowsTerminalCapabilities` (`agent-rpc-catalog-runtime.md:193`) |

## This is (mostly) a pure wiring gap — the pattern to copy already exists

`onboarding.detectAgents` (registered, `channels_onboarding.go:220-234`,
`onboardingDetectAgents` at `:254-316`) already establishes the exact resolve-then-relay
shape 4 of the 6 missing methods need: resolve `devServerId` → `client.RelayByDevServer(...)`
with `Method: "preflight.<name>"` → unmarshal `ResultJson`. Confirmed via
`specs/agent/api/agent-rpc-catalog-runtime.md:191-199` that the agent-side RPCs
`preflight.detectWindowsTerminalCapabilities`, `preflight.detectGhosttyConfig`, and
`preflight.setGitIdentity` already exist and are implemented on the agent (Part A/B parity
table) — so `detectWindowsCapabilities`, `detectGhosttyConfig`, and `setGitIdentity` are
**channel-wiring-only gaps**: copy `onboardingDetectAgents`'s skeleton, change the relayed
method name and result shape.

`detectAgentsAllServers` needs one more small piece: it's not a single agent RPC, it's a
fan-out — the old TS backend's `desktop/src/main/ipc/onboarding-ipc.ts:322-324`
(`detectAgentsAllDevServers`) calls the per-server detection across every dev server the
caller knows about and merges results keyed by `devServerId`. backend-go's channel would
need to enumerate dev servers (via `infra-fleet-service`, which it already talks to for
`ResolveConnection`/`RelayByDevServer`) and call the existing per-server relay once per
server — still no new proto RPC, just an orchestration loop in the handler.

`getPreflightStatus` is a **thin wrapper with a wrinkle**: the old TS backend's
`TASK-022-onboarding-ipc-preflight-handlers.md:37-64` shows it relays to the agent's
`preflight.check` **Contract B** (full gh/glab/git install+auth+identity probe, 30s TTL
cache) and returns a `RemotePreflightStatus`
(`frontend/src/shared/dev-server-types.ts:96`). This is a **different `preflight.check`**
from the one backend-go already registers: `channels.go:796-818`'s `preflight.check` is a
**local-only, no-relay** handler that always answers `gh`/`glab` `installed:false` because
"scm-integration-service is a direct OAuth API client, deliberately NOT a `gh`/`glab` CLI
wrapper" (`channels.go:805-809`). That design note is correct for backend-go's own
credential model, but `onboarding.getPreflightStatus` is asking a **different question** —
"what's actually installed/authenticated on the dev-server host's OS", which is real,
host-local information the agent can and does answer (per the Contract-B row in the RPC
catalog) independent of backend-go's own OAuth-vs-CLI design choice for GitHub API access.
So wiring this one correctly means relaying to the agent (like `detectAgents` does), not
reusing backend-go's existing local `preflight.check` handler — worth flagging explicitly
so nobody "closes" this gap by just aliasing the wrong channel.

`openGhAuthTerminal` was the one method with a real **cross-namespace dependency**:
per `TASK-022:91-105`, it needs to create a PTY on the dev server running `gh auth login`
and return a `ptyId` the frontend attaches a terminal pane to. It depended on
`terminal.create`'s spawn-and-AttachPty machinery, which was unregistered at the time this
report was written. **Resolved (2026-09-07, TASK-030):** now that `terminal.create` has
landed (TASK-019–021), `onboarding.openGhAuthTerminal` is implemented on top of it —
`registerOnboardingOpenGhAuthTerminalChannel` (`channels_onboarding.go`) resolves the
caller's `devServerId` to a `connectionId` via `ResolveConnection`'s `dev_server_id`
alternate key, then spawns and attaches a pty exactly like `terminal.create`, typing
`"gh auth login\n"` into it as terminal input. See TASK-030's own file for the full
implementation writeup.

## Local-machine-probe framing check (per audit brief)

Worth flagging explicitly since it wasn't obvious from the method names alone:
`detectGhosttyConfig` and `detectWindowsCapabilities` sound like they could be
local-Electron-only capability probes that a multi-tenant backend-go shouldn't need to
implement the same way desktop does. Checked directly against the call sites
(`runtime-onboarding-client.ts:97-106,119-128`) and they are **not** local-only in practice:
every one of these 6 missing methods takes a `devServerId` parameter and, per
`channels_onboarding.go`'s existing `onboarding.detectAgents` precedent, would relay to
*that specific dev server* via `RelayByDevServer` — i.e. the question being answered is
"what Ghostty config / Windows terminal capabilities exist on THIS dev-server host", not
"what exists on the backend-go process's own host." That is exactly as legitimate a
per-tenant, per-dev-server capability probe as `detectAgents` (already implemented this
way) or `preflight.check`'s Contract B — there is no local-only/desktop-Electron
architectural mismatch here, just unwired relay plumbing. Confirmed via
`grep -n "callRuntimeRpc" frontend/src/renderer/src/runtime/runtime-onboarding-client.ts`:
every wrapper in this file branches on `target.kind === 'local'` (not `!== 'environment'`),
meaning any non-local target — including a genuine multi-tenant backend-go environment —
routes through `callRuntimeRpc`, consistent with this being a real, intended remote
capability rather than a local-only concept that happens to go through the RPC layer.

## Owning service verdict

`infra-fleet-service`, via the same `RelayByDevServer` path `onboarding.detectAgents`
already uses — no new proto or usecase work needed for `detectWindowsCapabilities`,
`detectGhosttyConfig`, `setGitIdentity`, or `getPreflightStatus` (agent RPCs already exist).
`detectAgentsAllServers` needed a small orchestration loop in the `wscompat` handler, still
against existing RPCs. `openGhAuthTerminal` additionally depended on `terminal.create`
landing first — it has, and TASK-030 wired it on top, so all 6 are now resolved with no
new proto or usecase work in `infra-fleet-service` beyond RPCs that already existed.

---

## References

- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_onboarding.go:156-235` — current registrations + the `detectAgents` relay pattern to copy
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels.go:796-818` — the existing (different-contract, local-only) `preflight.check`
- `frontend/src/renderer/src/runtime/runtime-onboarding-client.ts:53-128` — all 6 missing call sites
- `specs/agent/api/agent-rpc-catalog-runtime.md:176-205` — agent-side `preflight.*` RPC parity table (proves the RPCs already exist)
- `specs/backend/crs/v1/onboarding/tasks/TASK-022-onboarding-ipc-preflight-handlers.md` — old TS backend's reference implementation shape for all 4 Phase-2 handlers
- `desktop/src/main/ipc/onboarding-ipc.ts:322-324` — `detectAgentsAllServers`'s fan-out semantics (desktop-local precedent)
- `frontend/src/shared/dev-server-types.ts:96,137` — `RemotePreflightStatus`/`WindowsTerminalCapabilities` result shapes
