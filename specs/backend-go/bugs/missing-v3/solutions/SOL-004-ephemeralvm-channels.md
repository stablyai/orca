# SOL-004: `ephemeralVm.*` — ship the full relay plumbing now (proven `EmulatorRelay` pattern), permanently block only the `ssh`-result path

**Resolves:** [BUG-004](../BUG-004-ephemeralvm-channels-not-implemented.md)
**Service:** `git-gateway-service` (recipe-definition reads, reusing repo→host dispatch) + `infra-fleet-service` (new `ephemeral_vm_runtimes` table, new `EphemeralVmRelay` usecase family, proto RPCs) + `api-gateway` (9 new `wscompat` channels)
**Affected files (proposed):**
- `backend-go/services/git-gateway-service/internal/usecase/read_ephemeral_vm_recipes.go` (new — mirrors `check_hooks.go`)
- `backend-go/proto/orca/gitgateway/v1/gitgateway.proto` (additive `ReadEphemeralVmRecipes` RPC, if `git-gateway-service` exposes a gRPC surface separate from `infra-fleet-service`'s; else add to whichever proto already carries repo-scoped reads)
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (additive: `ListEphemeralVmRuntimes`, `AttachEphemeralVmWorkspace`, `SuspendEphemeralVmWorkspace`, `ResumeEphemeralVmWorkspace`, `CleanupEphemeralVmWorkspace`, `GetEphemeralVmCleanupCommand`, `DoctorEphemeralVmRecipe`)
- `backend-go/services/infra-fleet-service/migrations/000X_ephemeral_vm_runtimes.up.sql` (new)
- `backend-go/services/infra-fleet-service/internal/usecase/ephemeral_vm_relay.go` (new — mirrors `emulator_relay.go`)
- `backend-go/services/infra-fleet-service/internal/adapter/postgres/ephemeral_vm_runtime_repository.go` (new)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_ephemeral_vm.go` (new)
- `agent/src/relay/agent-ephemeral-vm-handler.ts` (new — **out of scope for this proposal**, see "What ships now vs. what's blocked" below)
- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts` (remove `'ephemeralVm'` from `DESKTOP_ONLY_NAMESPACES` once the agent-side handler lands — not yet, see below)
**Status:** 🚧 Proposed — no code written

---

## Don't re-derive the prior investigation — build on it

`specs/backend/api/ephemeral-vm-server-mode-design.md` (2026-08-16, for the
old TS `backend/`) already did the hard analysis this bug asks for:
`OrcaVmRecipe` is four opaque shell-command strings a repo authors into its
own `orca.yaml`'s `environmentRecipes`
(`desktop/src/shared/types.ts`'s `OrcaVmRecipe`, cited at that doc's top);
`create`/`resume` must print one JSON result naming either an `orca-server`
pairing code or a bare `ssh` target
(`frontend/src/shared/ephemeral-vm-recipes.ts:76-97`'s
`EphemeralVmRecipeConnectionSchema` discriminated union — confirmed still
current); the shell command runs **on the Dev Server that owns the repo**,
never the shared backend container (§"Step 2 answer" of that doc). That
doc's conclusion stands unchanged against today's `backend-go` and is not
re-derived here.

What **has** changed since that doc was written, and is the reason this
proposal reaches a different, more actionable split than its "Option
A/B/C" menu: `backend-go` has since **shipped and proven**, end-to-end, the
exact "register the relay plumbing now, let a real agent-side 'method not
found' degrade to a typed, permanent, self-healing error" pattern that
doc's "Why a design doc instead of code" section worried was too risky to
build blind. That pattern is `SOL-008-emulator-channels.md`
(`specs/backend-go/bugs/missing-v1/solutions/`), and it is not a proposal
anymore — it is real, merged code:
`backend-go/services/infra-fleet-service/internal/usecase/emulator_relay.go:79-93`'s
`callAgent` translates `domain.ErrAgentMethodNotFound` into
`apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EMULATOR_UNSUPPORTED", ...)`,
and the RPCs it backs are live in the actual proto today
(`backend-go/proto/orca/infrafleet/v1/infrafleet.proto:124-131`, with the
file's own comment at lines 118-123 stating plainly: "agent/ has no
`device.*` RPC surface today ... every call below reaches a real agent and
fails with a typed, permanent `FailedPrecondition` until agent/ gains one").
**This proposal applies that exact, already-shipped shape to `ephemeralVm.*`
instead of re-litigating whether it's safe to ship unblocked plumbing** —
it's already been shipped once, for a structurally identical problem.

## Confirming (not re-deriving) the SSH-client gap against today's `agent/` source

BUG-004 asks specifically to re-verify the old doc's "no outbound SSH client
capability" claim against current `agent/` source, since that doc is TS-era
and could be stale. It is not stale:

- `agent/package.json:45,88` still lists `ssh2`/`@types/ssh2` as
  dependencies.
- `grep -rn "from '\''ssh2'\''" agent/src --include=*.ts` (excluding tests)
  returns **zero matches** — nothing in `agent/src` imports the `ssh2`
  package today.
- The only `ssh`-named modules that exist
  (`agent/src/main/ssh/ssh-channel-multiplexer.ts`,
  `ssh-filesystem-stream-reader.ts`, `ssh-git-response-stream-reader.ts`,
  `ssh-remote-platform.ts`, `ssh-target-id-migration.ts`) implement the
  **inbound** direction — the agent being reached *through* an SSH exec
  channel that Orca's own backend opened (`relay-ssh` transport mode, per
  `infra-fleet-service.md` §10's "3 connection modes"), not the agent
  opening an **outbound** SSH connection to a fourth, further host. None of
  them reference the `ssh2` package.

**Confirmed, not stale**: the Dev Server Agent has no outbound-SSH-client
capability today, on either the current `agent/` source or the TS-era
source the prior doc examined. The blocker for the `ssh`-type recipe result
is real and current.

## What ships now vs. what's blocked — three groups, not two

The prior doc's own "Group 1 / Group 2" split (recipe-definition reads vs.
"actually runs a shell command") is correct but, per its own "Why a design
doc instead of code" section, treated *all* of Group 2 as too risky to
scope in one pass. With `EmulatorRelay`'s pattern now proven, Group 2 itself
splits again — cleanly, along the exact fork the recipe result's own
discriminated-union type already encodes
(`ephemeral-vm-recipes.ts:76-95`'s `EphemeralVmRecipeConnectionSchema`):

| Group | Methods | Backing mechanism | Ships now? |
|---|---|---|---|
| **1 — recipe/runtime reads** | `listRecipes`, `listRecipeCatalog`, `doctor`, `getCleanupCommand`, `listRuntimes` | Read `orca.yaml`'s `environmentRecipes` off the repo's owning host via `git-gateway-service`'s existing repo→host dispatch + the agent's **already-existing** `fs.readFile` method; `listRuntimes` reads a new Postgres table | **Yes — no new agent capability needed at all** |
| **2a — `orca-server`-result lifecycle** | `attachWorkspace`, `suspendWorkspace`, `resumeWorkspace`, `cleanup` (when the recipe's `create`/`resume` stdout names an `orca-server` connection) | New, small agent-side `vm.exec` handler (spawn the recipe's shell command, parse JSON stdout) relayed via `infra-fleet-service.Relay`, `EmulatorRelay`-shaped `callAgent`/`KindFailedPrecondition` fallback | **Backend-go plumbing yes; functionally inert until the small `agent/` handler ships (see below)** |
| **2b — `ssh`-result lifecycle** | Same 4 methods, only when the recipe's result names an `ssh` target | Requires the Dev Server Agent to become an outbound SSH client to a *third* host — the real, large gap confirmed above | **No — permanently blocked pending a separate `agent/` subsystem** |

This is a materially different, more useful split than "ship Group 1, defer
everything else" (the prior doc's Option B): Group 2a is **not** blocked on
the SSH-client subsystem at all — it reuses the already-transport-agnostic
pairing-code mechanism the prior doc itself identified
(`addEnvironmentFromPairingCode`, cited there as needing "no new SSH
infrastructure"), and the new agent-side piece it does need
(`vm.exec` — `spawn(command, {shell:true, cwd, env})` + JSON-stdout
parsing) is the same small, self-contained shape as
`agent-cli-handler.ts`, not a new subsystem. Only 2b — specifically the
`ssh`-connection-type branch — hits the real, large, out-of-scope gap.

---

## Group 1 — recipe/runtime reads: full design, no `agent/` change needed

### Recipe/catalog reads reuse `git-gateway-service`'s repo→host dispatch

`git-gateway-service` already has the exact "resolve which host owns this
repo, then relay a single named read" pattern this needs, used today for
an almost identical shape of call —
`backend-go/services/git-gateway-service/internal/usecase/check_hooks.go:37-54`'s
`CheckHooks.Execute`: look up the repo via `ProjectClient.GetRepo`, call
`dispatchExecutorForRepo` (`.../adapter/grpcclient/relay_executor.go:458`)
to get a `(ctx, executor, repoPath)` triple that is either the local
executor or `RelayExecutor`, then call one named method on it. The relay
side of that same interface
(`relay_executor.go:598-604`'s `CheckHooks`) is a two-line wrapper over
`r.relay(ctx, repoPath, "git.checkHooks", map[string]any{"repoPath": repoPath}, &result)`
— the identical shape `ReadIssueCommand` (`relay_executor.go:608-614`) uses
for a different single-file read.

A new `ReadEphemeralVmRecipes` usecase mirrors `CheckHooks` exactly:

```go
// internal/usecase/read_ephemeral_vm_recipes.go
type ReadEphemeralVmRecipesResult struct {
	RepoPath    string
	Recipes     []domain.EphemeralVmRecipe // id, name, create/suspend/resume/destroy, destroyDisabled
	Diagnostics []string                    // orca.yaml parse warnings, mirrors loadHooks' environmentRecipeDiagnostics
}

func (uc *ReadEphemeralVmRecipes) Execute(ctx context.Context, repoID string) (ReadEphemeralVmRecipesResult, error) {
	repo, err := uc.projects.GetRepo(ctx, repoID)
	if err != nil {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindNotFound, "WORKTREE_REPO_NOT_FOUND", "repo does not exist", err)
	}
	ctx, executor, repoPath, err := dispatchExecutorForRepo(ctx, uc.reachability, uc.local, uc.relay, repo)
	if err != nil {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindInternal, "GITGATEWAY_RESOLVE_FAILED", "failed to resolve repo's owning host", err)
	}
	raw, err := executor.ReadFile(ctx, repoPath, "orca.yaml") // NOT a new agent method — see below
	if err != nil {
		return ReadEphemeralVmRecipesResult{}, apperrors.New(apperrors.KindInternal, "GITGATEWAY_READ_ORCA_YAML_FAILED", "failed to read orca.yaml", err)
	}
	return parseEnvironmentRecipes(raw) // pure function, ports desktop's loadHooks parsing logic for the environmentRecipes section only
}
```

**No new agent method required for this part**: the agent already exposes
`fs.readFile` (`agent/src/relay/agent-rpc-dispatch-fs.ts:31`), the exact
method `RelayExecutor`'s new `ReadFile` wrapper would call — this mirrors
the prior doc's own finding that "reading recipe *definitions* remotely is
already a solved problem, not new work," now grounded in `backend-go`'s
real, existing `fs.*` relay surface instead of the TS system's
`getRemoteFilesystemProvider`. `doctor`'s command-path checks
(`ephemeral-vm-recipe-doctor.ts`'s `checkCommandPath` in the desktop
source) port the same way, via `fs.stat`
(`agent-rpc-dispatch-fs.ts:53`) instead of a raw local `existsSync`.

`getCleanupCommand` is a pure function over an already-fetched recipe (no
I/O beyond the read above) — ports directly.

### `listRuntimes` needs a new Postgres table — the second gap the prior doc named

The prior doc's other blocker (independent of the SSH-client gap): no
durable, shared record of "which ephemeral VM runtimes exist, what state
are they in," reachable by every `backend-go` replica — desktop's
equivalent is a per-process local JSON file
(`ephemeral-vm-runtime-store.ts`), which cannot work across
horizontally-scaled `infra-fleet-service` pods
(`infra-fleet-service.md` §8's "a given `connectionId`'s live transport
lives on exactly one pod at a time" — the same statelessness constraint
applies here). This service is already the right owner per its existing
`dev_servers`/`connections` tables (`infra-fleet-service.md` §5) — a new
table, same schema pattern as `terminal_sessions`
(`infra-fleet-service.md:272-281`):

```sql
-- infra-fleet-service migrations
CREATE TABLE ephemeral_vm_runtimes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  repo_id         UUID NOT NULL,              -- logical FK -> project-service's repo
  recipe_id       TEXT NOT NULL,               -- matches OrcaVmRecipe.id from orca.yaml, not a Postgres FK (recipes are repo-authored, not backend-owned rows)
  connection_type TEXT NOT NULL CHECK (connection_type IN ('orca-server', 'ssh')),
  status          TEXT NOT NULL DEFAULT 'provisioning' CHECK (status IN
                     ('provisioning', 'active', 'suspended', 'error', 'destroyed')),
  environment_id  TEXT,                        -- set once an orca-server-type recipe's pairing succeeds; NULL for ssh-type (permanently blocked, see Group 2b)
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_ephemeral_vm_runtimes_repo ON ephemeral_vm_runtimes(repo_id) WHERE status <> 'destroyed';
```

`ListEphemeralVmRuntimes` is a plain tenant-scoped repository read, no
relay involved.

---

## Group 2a — `orca-server`-result lifecycle: full plumbing now, `EmulatorRelay`-shaped

`attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/`cleanup` all reduce
to "run the recipe's `create`/`suspend`/`resume`/`destroy` shell command on
the repo's Dev Server, then (for `create`/`resume`) parse its JSON stdout
and, if it names an `orca-server` connection, register that pairing code
the same way any other environment pairing works." The **shell-exec** half
needs one new, small agent-side handler; the **pairing** half needs none —
it is already fully transport-agnostic. `infra-fleet-service` ships all of
this now, following `emulator_relay.go`'s proven shape exactly:

```go
// internal/usecase/ephemeral_vm_relay.go
type EphemeralVmRelay struct {
	resolver ConnectionResolver
	agent    DevServerAgentClient
	runtimes EphemeralVmRuntimeRepository
}

// AttachWorkspace calls vm.exec with the recipe's `create` command, mirroring
// EmulatorRelay.AttachSession's resolve -> callAgent -> translate shape.
func (uc *EphemeralVmRelay) AttachWorkspace(ctx context.Context, connectionID, recipeID, createCommand string) (EphemeralVmRuntimeResult, error) {
	devServer, err := uc.resolveDevServer(ctx, connectionID) // identical to EmulatorRelay's — connectionId required, no local fallback: running a repo-authored shell command on the shared backend-go host is the same class of blast-radius problem browser/emulator driving already excludes it for
	if err != nil {
		return EphemeralVmRuntimeResult{}, err
	}
	result, err := uc.callAgent(ctx, devServer, "vm.exec", map[string]any{
		"recipeId": recipeID,
		"command":  createCommand,
		"phase":    "create",
	})
	if err != nil {
		return EphemeralVmRuntimeResult{}, err // real agent "method not found" -> apperrors.KindFailedPrecondition, INFRA_EPHEMERAL_VM_UNSUPPORTED, exactly like INFRA_EMULATOR_UNSUPPORTED
	}
	return uc.persistAndMaybePair(ctx, result) // parses the JSON stdout the agent captured, persists ephemeral_vm_runtimes row, and if connection.type == "orca-server", registers the pairing code via the existing environment-pairing mechanism (out of scope to re-derive here — see runtime-environments.ts's pairing flow)
}
```

`callAgent`'s "translate a real agent-side method-not-found into a typed,
permanent `apperrors.KindFailedPrecondition`" behavior
(`emulator_relay.go:79-93`) is reused verbatim in spirit: **the moment
`agent/` adds a `vm.exec` handler, these calls start working with zero
further `backend-go` changes** — exactly the property that made shipping
`EmulatorRelay`'s plumbing before `agent/`'s `device.*` surface existed the
right call, per that file's own doc comment (`emulator_relay.go:42-49`).

If the parsed result names an `ssh` connection instead of `orca-server`,
`persistAndMaybePair` returns the explicit, permanent Group 2b error below
rather than attempting anything — the same "ship the part that's real,
name the part that isn't" pattern the prior TS doc's Option B recommended
one level up.

`suspendWorkspace`/`resumeWorkspace`/`cleanup` are `SendCommand`-shaped
(mirroring `emulator_relay.go:154-166`'s fire-and-forget group), differing
only in which recipe field (`suspend`/`resume`/`destroy`) supplies the
command and which `ephemeral_vm_runtimes.status` transition follows a
success.

### The new `agent/` piece this group still needs — small, and separately scoped

Unlike Group 2b, this is not a new subsystem. Per the prior doc's own
"groundable" framing (confirmed unchanged): a new
`agent/src/relay/agent-ephemeral-vm-handler.ts`, shaped exactly like
`agent-cli-handler.ts` — `spawn(command, {shell: true, cwd: repoPath, env:
{...process.env, ORCA_VM_MODE, ORCA_VM_INSTANCE_ID, ORCA_RECIPE_ID,
ORCA_REPO_PATH}})`, parse one JSON object off stdout, same schema
`ephemeral-vm-recipes.ts`'s `EphemeralVmRecipeResultSchema` already
defines. This proposal does **not** implement it (it lives in `agent/`,
a different area than this `backend-go` bug set covers, mirroring
`SOL-008`'s own scope cut for `agent/`'s `device.*` surface) — it is
flagged here as the one piece separating "plumbing shipped" from
"functionally working," sized deliberately smaller than emulator driving
or the Group 2b SSH subsystem so whoever picks it up has an accurate
estimate.

---

## Group 2b — `ssh`-result lifecycle: permanently blocked, explicit error

When a recipe's `create`/`resume` result names an `ssh` connection
(`EphemeralVmRecipeConnectionSchema`'s `ssh` variant,
`ephemeral-vm-recipes.ts:84-90`), completing the flow requires the Dev
Server Agent to become an outbound SSH client to a *third* host, register
it as a hidden runtime-owned target, and expose fs/git provider dispatch
against it — the large, real gap reconfirmed above, unchanged from the
prior doc's assessment (`ssh-filesystem-dispatch.ts`/`ssh-git-dispatch.ts`
equivalents, an SSH2 client integration, identity-file/jump-host
resolution, a hidden-target registry distinct from user-visible SSH
targets). This is not sized like Group 2a's `vm.exec` handler — it is
comparable to desktop's `ipc/ssh.ts` + both provider-dispatch files
combined, per the prior doc's own estimate, which this proposal does not
revise.

```go
// persistAndMaybePair, Group 2b branch
if connection.Type == "ssh" {
	uc.runtimes.MarkError(ctx, runtimeID, "ssh-type ephemeral VM recipes require the Dev Server Agent to act as an outbound SSH client — not implemented; see specs/backend-go/bugs/missing-v3/solutions/SOL-004-ephemeralvm-channels.md Group 2b")
	return EphemeralVmRuntimeResult{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED",
		"this recipe provisions a bare SSH host, which the Dev Server Agent cannot yet reach outbound — only orca-server-type recipes are supported today", nil)
}
```

This error is **not** the same as Group 2a's `INFRA_EPHEMERAL_VM_UNSUPPORTED`
(which self-heals the moment `agent/` adds `vm.exec`) — `ssh`-type recipes
stay broken even after that lands, until the separate SSH-client subsystem
exists. Two distinct error codes keep that difference visible to whoever
debugs a failed `attachWorkspace` call, rather than collapsing both into one
generic "unsupported."

---

## `wscompat` wiring

```go
// channels_ephemeral_vm.go
func registerEphemeralVmChannels(r *Registry, gitGateway gitgatewayv1.GitGatewayServiceClient, infra infrafleetv1.InfraFleetServiceClient) {
	r.Register("ephemeralVm.listRecipes", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		in, err := decodeArg[struct{ RepoID string `json:"repoId"` }](args, 0)
		if err != nil {
			return nil, err
		}
		ctx = gatewaygrpc.AttachIdentity(ctx, usecase.Identity{TenantID: id.TenantID, UserID: id.UserID})
		rpcCtx, cancel := context.WithTimeout(ctx, rpcTimeout)
		defer cancel()
		resp, err := gitGateway.ReadEphemeralVmRecipes(rpcCtx, &gitgatewayv1.ReadEphemeralVmRecipesRequest{RepoId: in.RepoID})
		if err != nil {
			return nil, err
		}
		return recipeListResponse(resp), nil
	})
	// listRecipeCatalog, doctor, getCleanupCommand follow the same
	// decode -> AttachIdentity -> rpcTimeout -> ReadEphemeralVmRecipes/local-compute
	// shape (catalog additionally lists across all repos in a project; doctor
	// and getCleanupCommand are pure functions over one already-fetched recipe).

	r.Register("ephemeralVm.listRuntimes", func(ctx context.Context, id Identity, args []json.RawMessage) (any, error) {
		// ... -> infra.ListEphemeralVmRuntimes, plain Postgres read, no relay
	})
	for _, op := range []string{"attachWorkspace", "suspendWorkspace", "resumeWorkspace", "cleanup"} {
		registerEphemeralVmLifecycle(r, infra, "ephemeralVm."+op)
	}
}
```

`registerEphemeralVmLifecycle` follows `registerBrowserRelay`'s
representative shape from
`specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md`
(decode args, `AttachIdentity`, per-call timeout, call the gRPC method,
translate the response) — not repeated here since that file already
documents the pattern this reuses verbatim.

---

## Test plan

- `git-gateway-service/internal/usecase/read_ephemeral_vm_recipes_test.go`:
  fake `ProjectClient`/`GitExecutor`, local vs. relay dispatch (mirrors
  `check_hooks_test.go`'s existing structure), malformed `orca.yaml`
  produces `Diagnostics`, not an error.
- `infra-fleet-service/internal/usecase/ephemeral_vm_relay_test.go`: no
  `connectionId` → `KindFailedPrecondition` (no local fallback, mirrors
  `emulator_relay_test.go`'s `TestEmulatorRelay_ListDevices_NoConnectionID_FailsPrecondition`);
  real agent "method not found" → `INFRA_EPHEMERAL_VM_UNSUPPORTED`;
  parsed result names `ssh` → `INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`, runtime
  row marked `error`, no agent call attempted beyond the initial `vm.exec`.
- `ephemeral_vm_runtime_repository_test.go`: tenant-scoping enforced,
  mirrors `ssh_targets`' repository test shape.
- `channels_ephemeral_vm_test.go`: one test per channel, fake gRPC clients,
  asserts the identity/timeout wiring `SOL-006`'s
  `channels_browser_test.go` plan already established as this codebase's
  convention.
- **No agent-side test plan for `vm.exec` or the SSH-client subsystem** —
  both are out of scope for this proposal, per the flags above.

## What NOT to do yet

Do not remove `'ephemeralVm'` from `DESKTOP_ONLY_NAMESPACES`
(`frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:59`)
until `agent/` actually ships the `vm.exec` handler Group 2a depends on —
per that file's own header comment, doing so before a namespace's methods
really work turns a real regression (the namespace going missing again)
into silent noise. Group 1's methods (recipe/catalog/doctor/cleanup-command
reads, runtime listing) do become fully real the moment this proposal's
`backend-go`-side code ships, with zero `agent/` dependency — but the
namespace is suppressed as a whole today, and `attachWorkspace`/`cleanup`
(the two methods BUG-004 confirms are called from the live
worktree-creation flow) stay inert until Group 2a's agent handler exists.

## References

- `specs/backend/api/ephemeral-vm-server-mode-design.md` — the full prior
  investigation this proposal builds on (recipe shape, `create`/`resume`
  result schema, "Step 2 answer: recipe execution belongs on the Dev
  Server," the Group 1/Group 2 split, the SSH-client and Postgres-table
  gaps, Options A/B/C)
- `specs/backend-go/bugs/missing-v1/solutions/SOL-008-emulator-channels.md`
  — the proposal that established the "ship relay plumbing now, degrade to
  typed permanent `FailedPrecondition` until `agent/` catches up" pattern
  this proposal applies; **now implemented**, see next reference
- `backend-go/services/infra-fleet-service/internal/usecase/emulator_relay.go:31-93`
  — `EmulatorRelay`'s real, shipped `resolveDevServer`/`callAgent` shape,
  reused here for `EphemeralVmRelay`
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:14-140` (full RPC
  list, confirms no VM/recipe RPC exists yet), `:118-131` (emulator's
  "no backend-host fallback... fails with typed permanent
  FailedPrecondition until agent/ gains one" comment, the direct
  precedent), `:449-464` (`RelayRequest`/`RelayByDevServerRequest`, reused
  mechanism)
- `backend-go/services/git-gateway-service/internal/usecase/check_hooks.go:37-54`,
  `.../adapter/grpcclient/relay_executor.go:458` (`dispatchExecutorForRepo`),
  `:598-614` (`CheckHooks`/`ReadIssueCommand` relay wrappers) — the
  repo→host dispatch + single-named-read pattern `ReadEphemeralVmRecipes`
  mirrors
- `agent/src/relay/agent-rpc-dispatch-fs.ts:20-155` — confirms `fs.readFile`
  (line 31) and `fs.stat` (line 53) already exist, so Group 1 needs no new
  agent method
- `agent/package.json:45,88` (`ssh2` dependency present) and
  `agent/src/main/ssh/*.ts` (inbound-only SSH modules, zero `ssh2` imports)
  — reconfirms the outbound-SSH-client gap against current source, not
  just the TS-era doc
- `frontend/src/shared/ephemeral-vm-recipes.ts:76-125` —
  `EphemeralVmRecipeConnectionSchema`'s `orca-server`/`ssh` discriminated
  union, the exact fork Group 2a/2b split follows
- `specs/backend-go/tdd/services/infra-fleet-service.md` §5 (schema
  pattern for the new `ephemeral_vm_runtimes` table, mirrors
  `terminal_sessions`), §8 (pod statelessness — why a new Postgres table is
  required, not an in-memory map)
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md`
  — `registerBrowserRelay`'s representative `wscompat` wiring shape, reused
  for `registerEphemeralVmLifecycle`
- `frontend/src/renderer/src/runtime/desktop-only-rpc-error-suppressor.ts:59`
  — current `DESKTOP_ONLY_NAMESPACES` entry for `ephemeralVm`, and its own
  header comment governing when it's safe to remove
- `specs/backend-go/bugs/missing-v3/BUG-004-ephemeralvm-channels-not-implemented.md` — problem statement this resolves
