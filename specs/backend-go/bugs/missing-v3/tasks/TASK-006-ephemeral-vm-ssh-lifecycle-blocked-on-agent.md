# TASK-006: `ephemeralVm.*`'s `ssh`-connection-type lifecycle — permanently blocked on a new `agent/` outbound-SSH-client subsystem

**From Solution:** SOL-004 (Group 2b — `ssh`-result lifecycle)
**Priority:** P3 — documentation only, no code to build against a dependency chain; does not block TASK-001 through TASK-005, which cover every method this bug set can actually ship
**Service:** `agent` (the missing piece — out of scope for this `backend-go` bug set) / `infra-fleet-service` (where the permanent error this task documents lives, added as part of TASK-004)
**File:** none changed by this task — this is a documentation/reference task; see "What this task actually is" below
**Depends on:** TASK-004 (the `EphemeralVmRelay.SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace` methods this task's error condition applies to)
**Status:** `[ ]` TODO

---

## What this task actually is

**This is not a "do it later" placeholder — it is a permanent, out-of-scope boundary**, matching `missing-v1`'s honest-blocker precedent (`TASK-048-emulator-relay-design-blocked-on-agent.md`'s "This task is not shippable today and must not be implemented" framing, and the "Blocked-on-`agent/` tasks — do not start without a decision first" table in `missing-v1/tasks/README.md`). Per BUG-004/SOL-004, when a recipe's `create`/`resume` result names an `ssh` connection (`EphemeralVmRecipeConnectionSchema`'s `ssh` variant, `frontend/src/shared/ephemeral-vm-recipes.ts:84-90`) instead of an `orca-server` connection, completing `attachWorkspace`/`suspendWorkspace`/`resumeWorkspace`/`cleanup` for that runtime requires the Dev Server Agent to become an **outbound SSH client to a third host** — a real, large capability gap in `agent/` that this `backend-go`-focused bug set does not build.

There is **no code for this task to add that TASK-004 doesn't already cover**: the correct behavior for an `ssh`-type runtime is a typed, permanent error, which is cheap enough to be part of TASK-004's own usecase rather than deferred to a separate implementation pass (see "Where the real error branch lives" below). This task's job is to make that boundary **explicit and durable** — a place future readers land on before attempting to "fix" `ssh`-type ephemeral VMs by extending `EphemeralVmRelay`, so they find the real blocker immediately instead of rediscovering it.

## Confirming the blocker against current `agent/` source (not re-derived — already done by SOL-004, restated here for this task's own record)

- `agent/package.json:45,88` lists `ssh2`/`@types/ssh2` as dependencies, but `grep -rn "from '\''ssh2'\''" agent/src --include=*.ts` (excluding tests) returns **zero matches** — nothing in `agent/src` imports the `ssh2` package today.
- The existing `ssh`-named modules (`agent/src/main/ssh/ssh-channel-multiplexer.ts`, `ssh-filesystem-stream-reader.ts`, `ssh-git-response-stream-reader.ts`, `ssh-remote-platform.ts`, `ssh-target-id-migration.ts`) implement the **inbound** direction only — the agent being reached *through* an SSH exec channel Orca's own backend already opened (`relay-ssh` transport mode). None of them import `ssh2` or open an outbound connection to a **fourth** host.

Re-run these two checks before picking this task back up in the future — `agent/` may have changed since this was last confirmed:

```bash
grep -rn "from 'ssh2'" agent/src --include=*.ts | grep -v test
grep -rln "ssh2" agent/src
```

If either now returns real (non-test) hits reaching outbound, re-investigate — the premise may no longer hold.

### Why the agent's own two WS connection modes don't help here (sharper reasoning, 2026-09-07)

Worth stating precisely, since it is a distinction that is easy to blur: `agent/src/relay/`
has exactly two ways the agent itself connects to Orca —
`agent-connection-relay.ts` (**relay-websocket**: backend-go dials INTO a `WebSocketServer`
the agent runs on the dev-server host) and `agent-connection-direct.ts`
(**direct-websocket**: the agent dials OUTBOUND to backend-go, authenticating as
`config.devServerId`, for hosts with no inbound access — e.g. a future ephemeral VM behind
NAT). Both are, in every case, **the agent talking to Orca itself** — one connection, one
protocol (Orca's own flat JSON-RPC surface), just dialed in different directions depending
on network reachability. Neither mode is, or could be repurposed into, what this task needs:
an SSH2 client the agent opens **outbound to a fourth, unrelated host** named by a recipe,
over the SSH protocol, independent of and unrelated to the agent's own Orca connection. Even
if a future ephemeral VM's agent uses direct-websocket mode to reach Orca, that says nothing
about whether it can also dial some other arbitrary SSH host — that's the separate,
unbuilt capability this task is about. Do not treat "the agent already knows how to dial
outbound" (true, for its own Orca connection) as evidence this task is easier than it looks.

## Where the real error branch lives (already specified by TASK-004, not duplicated here)

`EphemeralVmRelay`'s `SuspendWorkspace`/`ResumeWorkspace`/`CleanupWorkspace` (TASK-004) take an already-resolved `command` string — by the time those methods run, something upstream (the `api-gateway` wscompat layer, TASK-005, reading the runtime's `connection_type` column) must have already decided this is an `orca-server`-type runtime; TASK-004/TASK-005 do not implement the branch that inspects `connection_type == "ssh"` and refuses instead. **That branch belongs in TASK-005's wscompat handlers** (or equivalently in `EphemeralVmRelay` itself, whichever the TASK-004/TASK-005 implementer finds cleaner once both are in front of them) as a small, explicit check:

```go
// Sketch only — land this inside TASK-005's suspendWorkspace/resumeWorkspace/
// cleanup handlers (or TASK-004's usecase methods), guarded on
// runtime.GetConnectionType() == "ssh":
if runtime.GetConnectionType() == "ssh" {
	return nil, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED",
		"this recipe provisions a bare SSH host, which the Dev Server Agent cannot yet reach outbound — only orca-server-type recipes are supported today; see specs/backend-go/bugs/missing-v3/tasks/TASK-006-ephemeral-vm-ssh-lifecycle-blocked-on-agent.md",
		nil)
}
```

This is deliberately **not** the same error code as `SuspendWorkspace`/etc.'s `INFRA_EPHEMERAL_VM_UNSUPPORTED` (real agent "method not found," self-heals the moment `agent/` adds `vm.exec`) — `INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED` stays broken even after `vm.exec` ships, until the separate subsystem below exists. Two distinct error codes keep that difference visible to whoever debugs a failed call, rather than collapsing both into one generic "unsupported." **If TASK-004/TASK-005 are implemented without this branch, add it as a small follow-up patch to whichever of those two files ends up owning the `connection_type` check — do not leave `ssh`-type runtimes falling through to the generic `INFRA_EPHEMERAL_VM_UNSUPPORTED`/`vm.exec`-not-found path, which would incorrectly imply they'll start working once `agent/` adds `vm.exec`.**

## Target design for the real subsystem — do not implement until `agent/` gains outbound-SSH-client capability

If this is ever picked up for real, per SOL-004's own estimate (comparable to desktop's `ipc/ssh.ts` + both provider-dispatch files combined — **not** sized like the small `vm.exec` handler TASK-004 depends on):

- **An SSH2 client integration** in `agent/` (the `ssh2` package is already a listed dependency, per the confirmation above, but unused for this purpose) — dialing a third host named by the recipe's `ssh` connection result (`EphemeralVmRecipeSshTargetSchema`, `ephemeral-vm-recipes.ts:47-72`: host/port/username/identityFile/identityAgent/proxyCommand/jumpHost/portForwards).
- **A hidden-target registry** distinct from user-visible SSH targets (`infra.ssh_targets`) — this connection is provisioned by a recipe, not registered by a user through the normal SSH-target UI.
- **fs/git provider dispatch equivalents** for this new hidden target — mirroring what `ssh-filesystem-stream-reader.ts`/`ssh-git-response-stream-reader.ts` already do for the *inbound* relay-ssh case, but now needed for an *outbound* third-hop connection the agent itself initiates and owns.
- Identity-file/jump-host resolution, and a decision on how (or whether) this hidden target's fs/git surface is exposed back through `git-gateway-service`'s existing repo→host dispatch (`dispatchExecutorForRepo`) — since an `ssh`-type ephemeral VM's repo now effectively lives on a *fourth* machine, not the Dev Server itself.

None of the above is implemented by this task, by TASK-004, or by TASK-005. Do not add proto RPCs, usecase methods, or `agent/` code for this design until a separate task explicitly picks it up with its own scoping pass — this section exists so that pass starts from an accurate map of the gap, not from scratch.

## Verify

No code changes; nothing to build or test. If a future implementer lands the small `connection_type == "ssh"` guard described above as part of TASK-004/TASK-005, that guard's test coverage belongs in those tasks' own test files (e.g. `ephemeral_vm_relay_test.go`: parsed/looked-up runtime with `connection_type == "ssh"` → `INFRA_EPHEMERAL_VM_SSH_UNSUPPORTED`, runtime status marked `error`, no `agent.Exec` call attempted) — not a new test file for this task.
