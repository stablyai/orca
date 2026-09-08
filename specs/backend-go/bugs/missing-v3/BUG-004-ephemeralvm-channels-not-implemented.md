# BUG-004: `ephemeralVm.*` channels not implemented in backend-go

**Service:** `api-gateway` (dispatch) — no owning service exists yet
**File:** `backend-go/services/api-gateway/internal/adapter/wscompat/*.go`
**Severity:** Medium — per-workspace ephemeral VM/container management is an opt-in, experimental feature (gated behind `settings.experimentalEphemeralVms`), but for a paired/web client whose active runtime target is a remote/backend-go-backed environment, all 9 methods are 100% unreachable: recipe listing, doctor checks, and workspace attach/suspend/resume/cleanup can never work.
**Status:** ❌ Open — capability gap, not just wiring.

---

## Description

`ephemeralVm.*` manages per-workspace ephemeral VMs/containers built from repo-defined
"recipes" (see `frontend/src/shared/ephemeral-vm-recipes.ts`) — e.g. spinning up a
disposable dev environment for a workspace, then attaching/suspending/resuming/cleaning
it up. The frontend's hybrid RPC client routes every one of the 9 request/response
methods to `callRuntimeRpc(target, 'ephemeralVm.X', ...)` whenever
`getActiveRuntimeTarget(settings)` resolves to `{kind: 'environment'}` (i.e.
`settings.activeRuntimeEnvironmentId` is set — a remote/backend-go-backed target), and
to `window.api.ephemeralVm.X` (real desktop IPC) only for `{kind: 'local'}`:

`frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:14-109` — every
exported function (`listRuntimeEphemeralVmRecipes`, `listRuntimeEphemeralVmRecipeCatalog`,
`doctorRuntimeEphemeralVmRecipe`, `listRuntimeEphemeralVmRuntimes`,
`attachRuntimeEphemeralVmWorkspace`, `suspendRuntimeEphemeralVmWorkspace`,
`resumeRuntimeEphemeralVmWorkspace`, `cleanupRuntimeEphemeralVmWorkspace`,
`getRuntimeEphemeralVmCleanupCommand`) follows this exact `if (target.kind === 'local') { window.api... } return callRuntimeRpc(target, 'ephemeralVm.X', ...)` shape.

None of the 9 `ephemeralVm.*` channel names appear in `wscompat`'s registered-channel
list (`grep -rhoE '\.Register\("[a-zA-Z0-9_.]+"' backend-go/services/api-gateway/internal/adapter/wscompat/*.go` — 309 channels total, zero matching `ephemeralVm`), so every call
falls through to `registry.go`'s `notImplementedHandler`.

This namespace is also exercised by real production code, not just settings UI:
`frontend/src/renderer/src/lib/ephemeral-vm-worktree-creation.ts` calls
`attachRuntimeEphemeralVmWorkspace`/`cleanupRuntimeEphemeralVmWorkspace` from the
worktree-creation flow itself (`prepareRequestForCreate`), so a remote/backend-go
target genuinely cannot create or tear down an ephemeral-VM-backed workspace.

## What's missing

The desktop-local implementation this namespace mirrors:

- `desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts:63-109` — `EPHEMERAL_VM_METHODS`,
  the desktop's own in-process RPC method table (used when a *paired mobile/web client
  talks to the desktop itself* as the runtime host), delegating to:
  - `desktop/src/main/ipc/ephemeral-vm-recipe-context.ts:66-92` — `listRecipeCatalog`,
    `getRecipeRepo` (repo → recipe list, read from the repo's `hooks.environmentRecipes`)
  - `desktop/src/main/ipc/ephemeral-vm.ts:61` — `doctorEphemeralVmRecipeForRepo`
  - `desktop/src/main/ipc/ephemeral-vm-runtime-handlers.ts:65,69,79,138,174,231` —
    `listEphemeralVmRuntimeRecords`, `attachEphemeralVmWorkspace`,
    `cleanupEphemeralVmWorkspace`, `suspendEphemeralVmWorkspace`,
    `resumeEphemeralVmWorkspace`, `getEphemeralVmCleanupCommand`

Notably, `getRecipeRepo` (`ephemeral-vm-recipe-context.ts:83-92`) explicitly rejects any
repo with a `connectionId` (an SSH/dev-server-backed repo) with `'Ephemeral VM recipes
run on the local desktop host in v1.'` — i.e. even the desktop's *own* local
implementation is scoped to local-filesystem repos only today. That is a distinct,
narrower restriction from this bug: this bug is about a *paired/web client's active
runtime target* (`settings.activeRuntimeEnvironmentId`, resolved by
`getActiveRuntimeTarget` in `frontend/src/renderer/src/runtime/runtime-rpc-client.ts:47-55`)
being a remote backend-go environment, which is an orthogonal transport-routing concept
from a workspace's own repo/SSH connection.

## Owning service verdict: none found

`infra-fleet-service` is the natural candidate (it already owns
dev-server/fleet/browser-profile/emulator/terminal/ssh concerns), but its proto has
**zero** VM/container/recipe-shaped RPCs:

`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:13-140` — the full
`InfraFleetService` RPC list covers dev servers, ssh targets, connections/relay, ssh
terminal sessions, PTY/screencast streaming, browser profiles, emulator devices, and
host capabilities — nothing resembling "recipe", "VM", or "container".

`backend-go/services/infra-fleet-service/internal/usecase/` — directory listing (72
files) confirms no `*recipe*`, `*vm*`, or `*container*` usecase exists.

No other service (`ai-provider-service`, `project-service`, etc.) references ephemeral
VMs, recipes, or workspace provisioning either. This is a **capability gap**: new
proto + usecase + adapter work is needed, not just a `wscompat` wrapper.

**Prior investigation, don't re-derive it**: this exact question was already
investigated once for the old TS `backend/` (not backend-go) on 2026-08-16 —
see `specs/backend/api/ephemeral-vm-server-mode-design.md` and the `ephemeralVm.*`
row in `specs/backend/api/desktop-only-rpc-parity-gaps.md`'s "Nhóm A" table. Its
conclusion: **not a "doesn't make sense remotely" namespace** (unlike `mobile.*`/
`orcaProfiles.*`), but "portable, blocked on missing infra" — a Dev Server Agent
would need to act as its own outbound SSH client to a third machine (no such
capability exists in `agent/` today) plus a new Postgres-backed runtime-state
table. That doc sketches 3 implementation options. `ephemeralVm` is currently
listed in `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts`'s
`DESKTOP_ONLY_NAMESPACES` (silencing the resulting console error as "expected"),
which is accurate for today's state but should be revisited — remove it from that
set the moment either backend (old or backend-go) actually ports this namespace,
per that file's own header comment.

## Missing channels

| Method | Frontend call site | Notes |
|---|---|---|
| `ephemeralVm.listRecipes` | `runtime-ephemeral-vm-client.ts:14-23` | No backing RPC on any service. |
| `ephemeralVm.listRecipeCatalog` | `runtime-ephemeral-vm-client.ts:25-33` | No backing RPC. |
| `ephemeralVm.doctor` | `runtime-ephemeral-vm-client.ts:35-44` | No backing RPC. |
| `ephemeralVm.listRuntimes` | `runtime-ephemeral-vm-client.ts:46-54` | No backing RPC. |
| `ephemeralVm.attachWorkspace` | `runtime-ephemeral-vm-client.ts:56-65` | Called from live worktree-creation flow (`ephemeral-vm-worktree-creation.ts`). |
| `ephemeralVm.suspendWorkspace` | `runtime-ephemeral-vm-client.ts:67-76` | No backing RPC. |
| `ephemeralVm.resumeWorkspace` | `runtime-ephemeral-vm-client.ts:78-87` | No backing RPC. |
| `ephemeralVm.cleanup` | `runtime-ephemeral-vm-client.ts:89-98` | Called from live worktree-creation flow. |
| `ephemeralVm.getCleanupCommand` | `runtime-ephemeral-vm-client.ts:100-109` | No backing RPC. |

Not in scope for this report (already excluded by the frontend's own design):
`ephemeralVm.provision` / `ephemeralVm.cancelProvision` / `ephemeralVm.onProvisionEvent`
stay `window.api`-only by design — see the "Why" comment at
`desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts:20-27` (streaming
stdout/stderr broadcast decoupled from request/response, not a clean RPC shape).

---

## References

- `frontend/src/renderer/src/runtime/runtime-ephemeral-vm-client.ts:1-109` — hybrid routing client, header "Why" comment
- `desktop/src/main/runtime/rpc/methods/ephemeral-vm.ts:20-109` — desktop-local RPC method table + provision/cancelProvision exclusion rationale
- `desktop/src/main/ipc/ephemeral-vm-recipe-context.ts:66-92` — `listRecipeCatalog`, `getRecipeRepo` ("runs on the local desktop host in v1" guard)
- `desktop/src/main/ipc/ephemeral-vm.ts:61` — `doctorEphemeralVmRecipeForRepo`
- `desktop/src/main/ipc/ephemeral-vm-runtime-handlers.ts:65-231` — runtime/workspace lifecycle handlers
- `frontend/src/renderer/src/lib/ephemeral-vm-worktree-creation.ts` — `prepareRequestForCreate`, live caller of `attachWorkspace`/`cleanup`
- `frontend/src/renderer/src/runtime/runtime-rpc-client.ts:47-55` — `getActiveRuntimeTarget` (environment vs. local target resolution)
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:13-140` — full `InfraFleetService` RPC list (no VM/recipe RPC)
- `backend-go/services/infra-fleet-service/internal/usecase/` — directory listing, no recipe/VM usecase
- `backend-go/services/api-gateway/internal/adapter/wscompat/registry.go` — `notImplementedHandler`
- `specs/backend-go/bugs/missing-v1/README.md` — methodology/format precedent
