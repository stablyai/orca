# BACKLOG-002: Resolve a bare runtime `environmentId` to a dev server

**Origin:** `specs/backend-go/bugs/missing-v3/tasks/TASK-022-environment-devserver-resolution-blocked-on-ephemeralvm.md` (SOL-008 Part 2); also the root cause of `files.browseServerDir`'s remaining gap in `specs/backend-go/bugs/missing-v3/BUG-015-files-createfile-watch-browseserverdir-not-implemented.md`
**Priority:** Medium — affects two real, user-facing features once `ephemeralVm.provision` exists
**Blocked on:** `ephemeralVm.provision` (does not exist anywhere in this codebase yet)

---

## What this is

A frontend "runtime target" can be a bare `runtime:<environmentId>` with
**no** SSH target and **no** dev-server binding — e.g. a workspace backed
purely by an (eventual) ephemeral VM, before it's attached to any concrete
compute. Two RPCs currently hard-fail for this specific case:

- `terminal.create` → `INFRA_TERMINAL_NO_COMPUTE_BOUND` (a clean, actionable
  error — see `spawn_terminal_session.go`; this part already shipped and is
  not itself broken, just permanently refusing this one case).
- `files.browseServerDir` → falls through to `notImplementedHandler`
  entirely (no channel registered at all).

Both need the same missing piece: a way to turn `environmentId` into a real
`connectionId`/`devServerId` server-side.

## Why it's blocked (confirmed by direct investigation, not guessed)

`infra.ephemeral_vm_runtimes` (the table `ephemeralVm.attachWorkspace` etc.
write to) has an `environment_id` column whose own migration comment says
it's "set once an orca-server-type recipe's **pairing** succeeds" — but the
code that would perform that pairing, `ephemeralVm.provision`, is
explicitly out of scope of the pass that built everything else in this
namespace (see `ephemeral_vm_relay.go`'s own doc comment: "the real
create-command exec happens in `ephemeralVm.provision`, out of scope for
this bug set"). **No code path today ever writes a real value into
`environment_id`** — the column exists, nothing populates it. There is
nothing to resolve yet.

## The concrete design, once `ephemeralVm.provision` is built

Investigated the real agent↔backend-go WebSocket mechanism to ground this
(2026-09-07/08), rather than leaving it abstract:

- `agent/src/relay/agent-connection-direct.ts` is the "agent dials outbound
  to Orca" mode, already fully built, using a `devServerId` the agent names
  itself with. This is exactly the mode a NAT'd/cloud ephemeral VM would
  need (Orca can't dial into it).
- The natural design: `ephemeralVm.provision` launches the recipe's VM
  running the agent binary in **direct mode**, with `devServerId` set to the
  `ephemeral_vm_runtimes` row's own id (or a fresh id written back onto that
  row). Once it dials in, it registers in `infra.connections` **exactly
  like any normal dev server** — no new "environment resolution" table is
  needed at all.
- At that point, `environment_id` could plausibly just **equal**
  `dev_server_id` (one column, not two) — a real simplification over the
  original task sketch's proposal of a brand-new `environment_bindings`
  port/table.
- `SpawnTerminalSession` already has the alternate-key resolution primitive
  this would need for free: `ResolveConnectionRequest` (`infrafleet.proto`)
  already supports `dev_server_id` as an alternate to `connection_id` — no
  proto change to `SpawnTerminalSessionRequest` would even be necessary if
  `environment_id` and `dev_server_id` turn out to be the same value.

## What NOT to do

Do not invent a standalone `environment_bindings` table or a one-off
resolution path just for `terminal.create` or `files.browseServerDir` —
both would duplicate whatever `ephemeralVm.provision`'s own design settles
on for "how does an environment acquire compute." Whoever picks up
`ephemeralVm.provision` should read this file's design sketch first, then
this backlog item (and `terminal.create`'s/`files.browseServerDir`'s own
consumers) fall out as small follow-ups, not a separate project.

## Verify (once unblocked)

- `spawn_terminal_session_test.go`: an `environmentId` with a resolvable
  binding falls through to the existing devServerId success path; one with
  no binding still returns `INFRA_TERMINAL_NO_COMPUTE_BOUND` (an
  unprovisioned environment, not a bug).
- A new `files.browseServerDir` wscompat channel, registered once this
  resolution exists, relaying to the same `devServer.browseDir`-style
  agent call the SSH/dev-server-bound paths already use.
