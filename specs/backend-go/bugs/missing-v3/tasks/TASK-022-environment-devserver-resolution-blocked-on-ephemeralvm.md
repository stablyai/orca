# TASK-022: `SpawnTerminalSession` resolving `environmentId -> devServerId` server-side — blocked on SOL-004's `ephemeralVm.*` work

**From Solution:** SOL-008 (Part 2 — the real capability closure, deliberately not designed further in the solution doc)
**Priority:** P3 — do not start until SOL-004's `ephemeralVm.*` tasks (TASK-001–TASK-008, a different agent's range) land and settle how an environment acquires compute
**Service:** `infra-fleet-service` (+ `api-gateway` wscompat wiring, + a proto change) — exact scope depends on SOL-004's design
**File:** `backend-go/services/infra-fleet-service/internal/usecase/spawn_terminal_session.go`, `backend-go/proto/orca/infrafleet/v1/infrafleet.proto`, `backend-go/services/api-gateway/internal/adapter/wscompat/channels_terminal.go`, `frontend/src/renderer/src/components/terminal-pane/remote-runtime-pty-transport.ts` — **none of these should be touched until the blocker below is resolved**
**Depends on:** TASK-001–TASK-008 (SOL-004, `ephemeralVm.*` — a different agent's task range). This task cannot start, even partially, before SOL-004's tasks define how an `environmentId` acquires a concrete dev server/connection binding.
**Status:** `[ ]` TODO — **BLOCKED, do not start**

---

## Context

TASK-019/020/021 (this same solution's other tasks) make the empty-
`ConnectionID` dead end *recoverable* — the user sees why a terminal
can't open and can go bind compute manually. They do not make the
terminal actually open for a `runtime:<environmentId>` target with no
binding yet. That is the real, remaining capability gap BUG-008 named,
and SOL-008 is explicit that closing it is **not this bug's design to
make**:

> "The actual capability gap — spawning a terminal that works for a
> `runtime:<environmentId>` target with no binding *yet* — requires
> resolving `environmentId` to a concrete dev server before
> `SpawnTerminalSession` ever sees an empty `ConnectionID`. That
> resolution cannot happen inside `infra-fleet-service` today because no
> backend-go service has an `environment` concept at all... This proposal
> does not attempt to design that binding — it isn't `terminal.create`'s
> to invent, and doing so here would duplicate whatever `ephemeralVm.*`'s
> own design settles on for how an environment acquires compute."
> (SOL-008, "Part 2")

Confirmed independently: a grep of `backend-go/services/infra-fleet-service`
and `backend-go/services/project-service` for `environment_id`/
`EnvironmentID` finds nothing — `environmentId`/`runtime:<environmentId>`
is purely a frontend construct today (`worktree-runtime-owner.ts`'s
`parseExecutionHostId`/`getRuntimeEnvironmentIdForWorktree`). There is no
table anywhere in backend-go mapping an environment to the dev server that
should host its terminals, and inventing one here would mean guessing at
(and likely duplicating or conflicting with) whatever storage shape
SOL-004's `ephemeralVm.attachWorkspace`/`resumeWorkspace` design settles
on for the same concept.

This task exists so the dependency is tracked explicitly and the target
shape is not lost — not to hand-wave a fake "implement it" checklist with
no real content, matching missing-v1/SOL-006's honest-blocker precedent
(see `specs/backend-go/bugs/missing-v1/tasks/TASK-036-document-browser-agent-driving-gap.md`
and `TASK-048-emulator-relay-design-blocked-on-agent.md` for the house
style this task follows).

## What unblocks this task

**Re-confirmed 2026-09-07, now much more precise than the original framing above:** the
`ephemeral_vm_runtimes` table (real, landed) already has an `environment_id` column, whose
own migration comment says it is "set once an orca-server-type recipe's pairing succeeds" —
but the code that would actually DO that pairing, `ephemeralVm.provision`, does not exist
anywhere in this codebase (`ephemeral_vm_relay.go`'s own doc comment says outright: "the real
create-command exec happens in `ephemeralVm.provision`, out of scope for this bug set").
So there is currently **no code path that ever sets `environment_id` to a real value** — the
column exists, but nothing populates it. This task is blocked not because the resolution
*mechanism* is unclear (see the sharpened target design below — it's now well understood)
but because the one upstream step that would create a live `environment_id` in the first
place hasn't been built yet. `ephemeralVm.provision` landing is still what unblocks this
task; whoever picks this up must read `ephemeralVm.provision`'s actual landed design (not
this file's sketch below) before writing any code.

## Target design (do not implement until `ephemeralVm.provision` lands — sketch only, kept for continuity)

**Sharpened 2026-09-07** against the now-confirmed agent WS connection mechanism
(`agent/src/relay/agent-connection-relay.ts` vs `agent-connection-direct.ts`) — this
supersedes the original sketch's `environment_bindings` table and new
`SpawnTerminalSessionRequest.environment_id` field with a simpler design that needs neither.

The agent has two ways to connect to Orca: **relay-websocket** (backend-go dials into a
`WebSocketServer` the agent runs on the dev-server host — the normal case for a reachable
host) and **direct-websocket** (`agent-connection-direct.ts`'s `connectDirect` — the agent
dials OUTBOUND to backend-go instead, authenticating as `config.devServerId`, for hosts
behind NAT/no inbound access). An ephemeral VM is exactly the case direct-websocket mode
exists for. The natural design for `ephemeralVm.provision`, once built: launch the recipe's
VM running the agent binary in **direct mode**, with `devServerId` set to the
`ephemeral_vm_runtimes.id` itself (or a fresh id minted and stored back onto that row).

Once that agent dials in, it registers in `infra.connections`/the dev-server tables **exactly
like any normal dev server** — no new "environment resolution" table or binding model is
needed at all. At that point, `environment_id` could plausibly just BE the same value as the
runtime's own `dev_server_id` (one column, not two, collapsing the distinction the original
sketch assumed would need bridging). And `SpawnTerminalSession` already has everything it
needs today via the existing `ResolveConnectionRequest.dev_server_id` alternate-key path
(`infrafleet.proto:252-267` — the same path TASK-030's `onboarding.openGhAuthTerminal`
already uses in production, and ai-provider-service's `TestConnection` before it) — **no
proto change to `SpawnTerminalSessionRequest` would even be needed**, contrary to the
original sketch's `environment_id = 6` field addition below (kept struck through for
continuity/contrast, not as the design to build):

```protobuf
// SUPERSEDED — no longer believed to be necessary, see the sharpened design
// above. Kept only so a future reader can see what this task used to
// propose and why it changed.
message SpawnTerminalSessionRequest {
  string connection_id = 1;   // unchanged
  string environment_id = 6;  // NOT NEEDED — environment_id can just equal
                               // dev_server_id once ephemeralVm.provision
                               // dials the agent in direct-websocket mode
                               // using the runtime's own id
  string cwd = 2;
  string shell = 3;
  int32  cols = 4;
  int32  rows = 5;
}
```

If a caller only has an `environmentId` (not yet knowing it equals a `dev_server_id`), the
resolution step is the same one-liner shape TASK-030 already ships:
`client.ResolveConnection(ctx, &ResolveConnectionRequest{DevServerId: environmentID})`, then
proceed exactly like `terminal.create`'s existing connection-bound path. This is a real
simplification opportunity over the original sketch — note it here for whoever eventually
builds `ephemeralVm.provision`, but do **not** implement any of it now:
`ephemeralVm.provision` still doesn't exist, so there is nothing to resolve yet, and the
above remains a sketch, not a landed design, until that lands and is read directly.

## What this task deliberately does not do

- Does not add a local-pty adapter, `node-pty`, or any shell-spawning code
  to `infra-fleet-service` or any other backend-go service — ruled out by
  `infra-fleet-service.md`'s Hard Boundary table (see SOL-008's own
  "architecture question" section).
- Does not invent an `environment -> devServer` binding model or new table — per the
  sharpened design above, `ephemeralVm.provision` dialing in direct-websocket mode with
  `devServerId` set to the runtime's own id would make `environment_id` and `dev_server_id`
  the same value, needing no separate binding model at all. That is still
  `ephemeralVm.provision`'s decision to actually build, not this task's, even once
  unblocked — this file only documents the shape so the next implementer isn't guessing.
- Does not touch `resolveTerminalSession`, `AttachPty`, or the working,
  tested connection-bound `terminal.create` flow.

## Verify

Not applicable until unblocked — this task has no code to run yet. Once
SOL-004's binding design lands and this task is picked up, its test plan
is: a `spawn_terminal_session_test.go` case asserting an `environmentId`
with a resolvable binding falls through to the existing devServerId
success path, and a case asserting an `environmentId` with no binding
still returns `INFRA_TERMINAL_NO_COMPUTE_BOUND` (not a different error) —
write these against SOL-004's actual repository interface, not the
illustrative sketch above.
