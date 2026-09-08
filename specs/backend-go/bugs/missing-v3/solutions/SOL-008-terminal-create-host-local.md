# SOL-008: Don't give backend-go a PTY of its own — resolve `runtime:<environmentId>` to a real dev server before `terminal.create`, and make the "no compute bound" dead end actionable in the meantime

**Resolves:** [BUG-008](../BUG-008-terminal-create-host-local-connectionless-unsupported.md)
**Service:** `infra-fleet-service` (owns `SpawnTerminalSession`/`resolveTerminalSession`) + `api-gateway` (`wscompat` error surfacing) + frontend (`terminal-pane/remote-runtime-pty-transport.ts`) for the near-term fix; depends on whichever service ends up owning the `environmentId -> devServerId` binding (see "Dependency" below) for the real capability closure
**Affected files (proposed):**
- `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go` (new error code, later: environment resolution)
- `backend-go/services/infra-fleet-service/internal/usecase/terminal_session_lookup.go` (same error-code treatment for symmetry)
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto` (later phase only: additive `environment_id` field on `SpawnTerminalSessionRequest`)
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go` (later phase only: thread `environmentId` through `terminalCreateArgs`)
- `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` (catch the new error code, surface a "bind compute" affordance instead of a generic failure)
- No new files — this is entirely inside existing usecases/channels
**Status:** 🚧 Proposed — no code written

---

## The architecture question BUG-008 asks us to resolve first

BUG-008 frames the core design question correctly: when a `runtime:<environmentId>` target has no SSH/dev-server binding, what host should the PTY actually run on? Before picking an answer, check whether backend-go is even allowed to be that host.

`infra-fleet-service.md` §2 ("Bounded context") answers this directly, in a table, not as an aside:

```
**Hard boundary**: PTY, git, and filesystem **execution** stays on the Dev
Server Agent (`agent/`), a different system entirely, out of scope for this
Go rewrite...

| Concern | Owned by `infra-fleet-service` | Owned by the Dev Server Agent |
|---|---|---|
| PTY byte I/O (the actual terminal data stream) | No — routes the request to the right connection, does not touch the bytes | Yes (`node-pty` on the target host) |
```

(`specs/backend-go/tdd/services/infra-fleet-service.md:37-38,55-66`). This isn't scoped to the connection-bound case — it's stated as `infra-fleet-service`'s entire mandate ("never runs a shell command, reads a file, or moves PTY bytes itself", line 37-38). A "host-local PTY adapter in backend-go" — the comment in `spawn_terminal_session.go:28-36` frames this as the first-choice fix — would mean this one service spawning `node-pty`/`os/exec` directly inside its own gRPC server process. That's not a missing feature inside the existing design, it's a different architecture than the one the hard-boundary table describes.

`08-inter-service-communication.md`'s "Talking to the Dev Server Agent" section (`architecture/08-inter-service-communication.md:84-108`) reinforces this from the other direction: `infra-fleet-service` and `git-gateway-service` are named as "the only two Go services that talk to the execution plane" — and even *that* talking is relay/routing, never becoming the execution plane itself. Nothing in either document, or in `07-security-architecture.md`, describes backend-go running arbitrary tenant-supplied shell commands in its own process as a sanctioned model:

- `07-security-architecture.md`'s AuthN table (`architecture/07-security-architecture.md:5-10`) lists exactly four client classes reaching backend-go (browser, mobile, CLI/service-to-service, Dev Server Agent) — there is no fifth row for "backend-go executes work on behalf of a client directly," because that's not a thing any service in this architecture does.
- The same doc's "Multi-tenancy isolation" section (lines 54-66) is built entirely around database-row isolation (`tenant_id` filtering, RLS) — it has no isolation model at all for "one tenant's shell process running inside a shared backend-go pod," because no service is designed to host one.
- `02-microservices-decomposition.md`'s "what's deliberately not a separate service" framing (cited by `infra-fleet-service.md:56-58` for this exact boundary) already treats arbitrary execution as belonging to `agent/` categorically, not case-by-case.

**Conclusion: a backend-go-hosted PTY is off the table.** It would require inventing an entirely new, unreviewed execution/isolation surface (arbitrary shell access inside a shared gRPC service pod, with no tenant sandboxing story anywhere in the security architecture) to route around a gap that the design already has a real answer for: **resolve the environment to a real host before asking for a terminal, don't spawn one when there is no host.**

## Confirming the frontend's own evidence: this is never the "genuine desktop-local" case

`SpawnTerminalSession`'s doc comment (`spawn_terminal_session.go:28-36`) writes the empty-`ConnectionID` case as if it might mean "the user's own local machine" in non-`serverDeployment` mode. Tracing the frontend's actual transport selection shows this is not what happens in practice:

- `pty-connection.ts:3118-3124`: the **local** IPC/electron-pty path is chosen when `!connectionId && runtimeEnvironmentId === null` — i.e., genuine desktop-local terminals never call backend-go's `terminal.create` at all; they use `getLocalProjectExecutionRuntimeContext` and Electron's own registered PTY provider directly.
- The **remote-runtime** transport (`remote-runtime-pty-transport.ts`, the one that calls `terminal.create`) is selected whenever `runtimeEnvironmentId !== null` (`pty-connection.ts:3109-3125`), and it is `runtimeEnvironmentId`, not `connectionId`, that decides this — `getRuntimeEnvironmentIdForWorktree` (`worktree-runtime-owner.ts:162-193`) recognizes a bare `runtime:<environmentId>` host independently of any SSH/dev-server binding.

So by construction, every empty-`ConnectionID` `terminal.create` call `SpawnTerminalSession` ever sees is a `runtime:<environmentId>` target with no dev-server/SSH binding — never a "run this on my own desktop" request, because that request is never routed through backend-go in the first place. `uc.serverDeployment == false` doesn't change this; it only changes which of the two existing error codes fires, not what kind of caller is on the other end. This matters because it means the fix does not need to disambiguate "desktop-local" from "unbound runtime environment" — there is only one real caller shape to design for.

## Design — two parts, one shippable now, one blocked on a real dependency

### Part 1 (in scope now): make the dead end actionable instead of a generic failure

Today, `INFRA_TERMINAL_HOST_LOCAL_UNIMPLEMENTED`/`_DISABLED` (`spawn_terminal_session.go:61-66`) and the parallel `INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED` every other terminal control-plane op hits via `resolveTerminalSession` (`terminal_session_lookup.go:36-42`) reach the frontend as an opaque RPC failure — `remote-runtime-pty-transport.ts`'s own comment (lines 900-906) documents that this was "found live," i.e., discovered as a raw failure, not designed for.

Given Part 1's finding above (every real caller here is an unbound `runtime:<environmentId>`), rename the message's framing from "not implemented" (implies a TODO) to what it actually is — a **precondition the caller can fix**:

```go
// spawn_terminal_session.go — replace the two existing branches' messages,
// keep the same error codes (frontend/tests may already match on them) but
// make the message and Kind reflect "bind compute first", not "unimplemented":
if in.ConnectionID == "" {
    if uc.serverDeployment {
        return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_HOST_LOCAL_DISABLED", "host-local terminal sessions are disabled in server-deployment mode", nil)
    }
    // Every real caller reaching this branch is a runtime:<environmentId>
    // target with no dev-server/SSH binding (see SOL-008's frontend trace) —
    // never a genuine desktop-local request, which never reaches this RPC.
    // KindFailedPrecondition (not KindUnimplemented) + a stable code the
    // frontend can switch on, so this renders as a fixable state ("bind a
    // dev server to this environment") rather than a bug report.
    return domain.TerminalSession{}, apperrors.New(apperrors.KindFailedPrecondition, "INFRA_TERMINAL_NO_COMPUTE_BOUND", "this environment has no dev server or SSH connection bound — attach compute before opening a terminal", nil)
}
```

Apply the identical code/message swap to `terminal_session_lookup.go:36-42`'s `INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED` guard, for the same reason: it's reached by resize/kill/focus/etc. on a session that could only exist if creation had somehow produced one, so it should read the same way to anyone debugging it.

On the frontend, `remote-runtime-pty-transport.ts`'s `connect()` (around the `callRuntimeWithColdStartRetry('terminal.create', ...)` call, lines 897-924) gets a catch clause matching `INFRA_TERMINAL_NO_COMPUTE_BOUND` that surfaces a distinct pane state — "This environment has no compute attached" with a call to action (e.g., open the environment's dev-server/SSH binding UI), instead of falling through to whatever generic transport-failure UI a thrown RPC error produces today. This is a real, immediately shippable fix: it doesn't add any capability, it turns a silent dead end into a recoverable one, which is the terminal-pane-level equivalent of what `channels_dev_server_access_control.go`'s cross-service pattern already does for `devServer.listForUser` (surface a specific, actionable denial rather than a bare error).

### Part 2 (the real gap — blocked on a genuine dependency, flagged honestly)

The actual capability gap — spawning a terminal that works for a `runtime:<environmentId>` target with no binding *yet* — requires resolving `environmentId` to a concrete dev server before `SpawnTerminalSession` ever sees an empty `ConnectionID`. That resolution cannot happen inside `infra-fleet-service` today because **no backend-go service has an `environment` concept at all**: `environmentId`/`runtime:<environmentId>` is purely a frontend construct today (`worktree-runtime-owner.ts`'s `parseExecutionHostId`/`getRuntimeEnvironmentIdForWorktree`) — a grep of `backend-go/services/infra-fleet-service` and `backend-go/services/project-service` for `environment_id`/`EnvironmentID` finds nothing. There is no table anywhere in backend-go mapping an environment to the dev server that should host its terminals.

BUG-008 already names the one place that binding would come from: `ephemeralVm.attachWorkspace`/`resumeWorkspace` (assigned separately as SOL-004, `BUG-004-ephemeralvm-channels-not-implemented.md`) "looks like the natural provisioning step that should hand `SpawnTerminalSession` a concrete dev-server/connection id for a `runtime:<environmentId>` target before a terminal is ever requested." This proposal does not attempt to design that binding — it isn't `terminal.create`'s to invent, and doing so here would duplicate whatever `ephemeralVm.*`'s own design settles on for how an environment acquires compute. What this proposal commits to, once that binding exists (in whatever shape SOL-004 lands it — a new `environment_bindings` table, a field on an existing dev-server row, etc.):

```protobuf
// infrafleet.proto — additive, mirrors ResolveConnectionRequest's existing
// connection_id / dev_server_id / worktree_id alternate-key pattern
// (infrafleet.proto:207-219)
message SpawnTerminalSessionRequest {
  string connection_id = 1;   // unchanged
  string environment_id = 6;  // NEW — resolved server-side to a devServerId
                               // via whatever repository SOL-004 introduces,
                               // BEFORE the empty-connection_id branch fires
  string cwd = 2;
  string shell = 3;
  int32  cols = 4;
  int32  rows = 5;
}
```

```go
// spawn_terminal_session.go — Execute, new first branch (illustrative;
// EnvironmentBindings is whatever repository/port SOL-004 actually defines)
if in.ConnectionID == "" && in.EnvironmentID != "" {
    devServerID, found, err := uc.environmentBindings.ResolveDevServer(ctx, tenantID, in.EnvironmentID)
    if err != nil {
        return domain.TerminalSession{}, apperrors.New(apperrors.KindInternal, "INFRA_ENVIRONMENT_RESOLVE_FAILED", "failed to resolve environment's dev server binding", err)
    }
    if found {
        in.ConnectionID = devServerID // falls into the existing devServerId fallback path, spawn_terminal_session.go:72-89
    }
}
// ... existing in.ConnectionID == "" branch (now INFRA_TERMINAL_NO_COMPUTE_BOUND) only fires
// when the environment genuinely has no binding yet, which is the correct,
// user-actionable outcome — not a bug, an unprovisioned environment.
```

`channels_terminal.go`'s `terminalCreateArgs` (currently `ConnectionID`/`Cwd`/`Shell`/`Cols`/`Rows`, lines 219-225) gains an `environmentId` field threaded straight through to `SpawnTerminalSessionRequest.EnvironmentId`, and `remote-runtime-pty-transport.ts`'s call site adds `environmentId: runtimeEnvironmentId` alongside the existing conditional `connectionId` spread (its own comment at line 901 already anticipates needing more than `connectionId` here).

**This part is explicitly not designed further here** — same honesty standard as SOL-006's agent-capability flag — because its shape depends entirely on decisions that belong to SOL-004/`ephemeralVm.*`, not to this bug. Shipping Part 1 alone is a complete, real fix for the user-visible symptom (a permanent silent dead end becomes a recoverable, explained one); Part 2 is what actually lets a terminal open without the user manually binding a dev server first, and should be picked up together with or after `ephemeralVm.*` lands.

## What this proposal deliberately does not do

- Does not add a local-pty adapter, `node-pty`, or any shell-spawning code to `infra-fleet-service` or any other backend-go service — ruled out by the Hard Boundary table above.
- Does not invent an `environment -> devServer` binding model — that's SOL-004's decision to make, not this bug's.
- Does not change `resolveTerminalSession`'s connection-bound path, `AttachPty`, or anything in the working, tested connection-bound `terminal.create` flow (`channels_terminal_test.go:201-337`) — this proposal touches only the empty-`ConnectionID` branch and its error surfacing.

## Test plan

- `spawn_terminal_session_test.go`: assert the renamed `INFRA_TERMINAL_NO_COMPUTE_BOUND` code/message on the non-server-deployment empty-`ConnectionID` path; keep the existing `INFRA_TERMINAL_HOST_LOCAL_DISABLED` server-deployment assertion unchanged (only the sibling branch's code changes).
- `terminal_session_lookup_test.go` (or equivalent): same code rename assertion for `resolveTerminalSession`'s guard.
- Frontend: a `remote-runtime-pty-transport` unit test asserting a thrown `INFRA_TERMINAL_NO_COMPUTE_BOUND` RPC error surfaces the "bind compute" pane state, not the generic transport-failure path.
- Part 2's tests (environment-binding resolution, `EnvironmentID` threading) belong with whichever PR actually introduces the environment-binding repository — not designed here since the repository itself isn't designed here.

## References

- `specs/backend-go/tdd/services/infra-fleet-service.md:37-38,55-66` — the Hard Boundary table; the load-bearing citation ruling out a backend-go-hosted PTY
- `specs/backend-go/tdd/architecture/08-inter-service-communication.md:84-108` — "Talking to the Dev Server Agent," confirms only relay/routing, never becoming the execution plane
- `specs/backend-go/tdd/architecture/07-security-architecture.md:5-10,54-66` — AuthN client-class table and multi-tenancy isolation model, neither of which contemplates backend-go executing tenant work in-process
- `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go:28-36,55-66` — the existing doc comment and error branches this proposal modifies
- `backend-go/services/infra-fleet-service/internal/usecase/terminal_session_lookup.go:36-42` — the parallel `INFRA_TERMINAL_HOST_LOCAL_UNSUPPORTED` guard, given the same treatment
- `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go:219-225,227-274` — `terminalCreateArgs`/`registerTerminalCreateChannel`, where `environmentId` would be threaded through in Part 2
- `backend-go/proto/orca/infrafleet/v1/infrafleet.proto:207-219,565-571` — `ResolveConnectionRequest`'s existing alternate-key pattern (precedent for `SpawnTerminalSessionRequest.environment_id`) and `SpawnTerminalSessionRequest`'s current fields
- `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts:898-924` — the `terminal.create` call site and its own "found live 2026-08-30" comment
- `frontend/src/renderer/src/components/terminal-pane/pty-connection.ts:3103-3125` — transport-selection logic proving the local-desktop path never reaches backend-go's `terminal.create`
- `frontend/src/renderer/src/lib/worktree-runtime-owner.ts:102-107,162-193` — `getRuntimeEnvironmentIdForWorktree`, confirms `environmentId` is a frontend-only concept today
- `specs/backend-go/bugs/missing-v3/BUG-004-ephemeralvm-channels-not-implemented.md` — the sibling gap this proposal's Part 2 depends on
- `specs/backend-go/bugs/missing-v1/solutions/SOL-006-browser-channels.md` — house style for honestly flagging a dependency on out-of-scope work rather than hand-waving it
