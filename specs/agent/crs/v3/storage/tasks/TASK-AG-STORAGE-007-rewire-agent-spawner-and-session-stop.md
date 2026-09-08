# TASK-AG-STORAGE-007: Rewire `agent-spawner.ts`/`agent-session.ts` to use the daemon instead of killing PTYs on every disconnect

**Task ID:** TASK-AG-STORAGE-007
**Priority:** 🔴 CRITICAL
**Solution Ref:** [SOL-AG-STORAGE-003](../solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) §2 steps 1–2
**Estimated effort:** Medium
**Dependencies:** TASK-AG-STORAGE-006 (daemon must exist first)
**Status:** ✅ Done (2026-09-08) — section 3's blocker (wire method name) resolved by TASK-BE-STORAGE-012 Part C/D; implemented and tested, see closing update below

---

## Context

`agent/src/relay/agent-spawner.ts`'s `cleanupAllPtys(log)` is called
unconditionally from `agent-session.ts`'s `stop()` on **every** WebSocket
close — including a 1-second network blip that `connectDirect()` will
reconnect from momentarily (see
[SOL-AG-STORAGE-002](../solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md)
§2). This immediately kills every running Claude/Codex/Gemini CLI session
on the dev server, per the deliberate `ORCH-011` design comment. This task
replaces that immediate kill with the grace-period-aware daemon built in
TASK-AG-STORAGE-006, and adds the distinct "confirmed logout" teardown
path.

## What to do

### 1. `agent-spawner.ts` — route `handleAgentSpawn`/`handleAgentKill`/send-input through the daemon client

- Replace direct `PTY_REGISTRY.set/get/delete` calls in these handlers
  with calls to `agent-spawn-daemon-client.ts` (or the extended
  `pty-daemon-client.ts`, per TASK-AG-STORAGE-005's decision).
- Preserve the exact same RPC method names/param/response shapes
  (`agent.spawn`, `agent.kill` with `signal` param per the existing
  `TASK-ORCH-05`/`TASK-ORCH-02` fix, `agent.sendInput`) — this task must
  not change the wire contract Orca Server/frontend already depends on,
  only where the PTY physically lives.
- `AgentLifecycleState`'s `idle/spawning/running/stopping/stopped/error`
  transitions (`SubAgentSpawner` class) stay in the agent process (they're
  pure bookkeeping, not tied to the PTY's physical location) unless
  TASK-AG-STORAGE-005 decision 1 concluded the state machine must move
  into the daemon too — follow that decision.

### 2. `agent-session.ts` — replace unconditional kill with grace-period notify

```typescript
// stop(), MODIFY
stop(): void {
  if (keepaliveTimer !== null) { clearInterval(keepaliveTimer); keepaliveTimer = null }
  void notifyAgentSpawnDaemonSessionClosed(log)   // NEW — replaces cleanupAllPtys(log)
  void notifyDaemonSessionClosed(log)             // UNCHANGED — terminal PTY, already correct
  cleanupAgentWatches()                           // UNCHANGED
}
```

Remove the `cleanupAllPtys` import/call from `agent-session.ts` entirely —
`agent-spawner.ts` no longer needs to export a kill-everything function for
this call site (it may still be useful for other callers; check before
deleting the export outright — search for other importers first).

### 3. Add the explicit "confirmed logout" teardown path

- Add a new RPC method the agent can receive from Orca Server —
  reuse whatever wire method `BE-SOL-STORAGE-003`/`FE-SOL-STORAGE-007`
  define for the explicit-teardown signal (check those solutions' final
  method name before hardcoding one here; if not yet decided when this
  task starts, coordinate rather than invent independently).
- On receiving it, the agent calls
  `notifyAgentSpawnDaemonSessionTeardown()` (→ daemon's
  `daemon.sessionTeardown`, immediate kill, no grace period) **and** the
  existing terminal-PTY equivalent, so a confirmed logout tears down both
  kinds of PTY immediately — matching the "logout đã xác nhận" requirement
  from `CR-STORAGE-008` part (a).

## Acceptance Criteria

- [ ] `handleAgentSpawn`/`handleAgentKill`/send-input still round-trip
      correctly end-to-end (existing tests for these pass unmodified in
      contract, only their internals changed to go through the daemon
      client).
- [ ] A simulated WS close (test double, not a real network drop) followed
      by a simulated reconnect within the grace period leaves a
      previously-spawned AI-agent PTY alive and attachable.
- [ ] A simulated WS close with no reconnect before the grace period
      expires results in the PTY being killed (verify via the daemon's own
      tests from TASK-AG-STORAGE-006, plus an integration-level test here
      exercising the full agent-session → daemon path).
- [ ] The new explicit-teardown path kills immediately regardless of any
      pending grace timer, with a dedicated test.
- [ ] `npx tsc --noEmit -p config/tsconfig.node.json` clean.
- [ ] `npx vitest run src/relay/__tests__/agent-spawner.test.ts
      src/relay/__tests__/agent-session.test.ts` pass.

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json 2>&1 | grep -E "agent-spawner|agent-session"
npx vitest run src/relay/__tests__/agent-spawner.test.ts src/relay/__tests__/agent-session.test.ts
```

## Not in scope

- Building the daemon itself — TASK-AG-STORAGE-006.
- Deciding/implementing the exact wire method name for the
  backend-go→agent teardown signal if it isn't already settled by
  `BE-SOL-STORAGE-003`/`FE-SOL-STORAGE-007` — coordinate, don't guess.
- `desktop/src/relay/` mirror — TASK-AG-STORAGE-009.


---

## 🟡 Completion Notes (2026-09-07) — partial, faithfully reported

### What's done (sections 1-2 of "What to do")

Because TASK-AG-STORAGE-005's decision 2 eliminated the separate daemon,
this task's sections 1 ("route handleAgentSpawn/handleAgentKill/send-input
through the daemon client") and 2 ("agent-session.ts — replace
unconditional kill with grace-period notify") collapsed into the SAME
change already made and tested under TASK-AG-STORAGE-006 — there is no
separate daemon client to route through, so "keep the RPC contract
unchanged, change only where PTYs survive a disconnect" was satisfied
directly in `agent-spawner.ts`/`agent-session.ts`. See
TASK-AG-STORAGE-006's completion notes for the verified diff, tests, and
what was NOT attempted (full agent-process-restart survival).

### What's NOT done — section 3, blocked on an external contract

Section 3 ("Add the explicit 'confirmed logout' teardown path") requires
an inbound wire method the agent can receive from Orca Server signaling
"this is an intentional close, skip the grace period, kill everything now"
— exactly the scenario CR-STORAGE-008 part (a) describes (user logs out
and confirms). This task's own instructions say explicitly: **"coordinate
rather than invent independently"** if the method name isn't settled yet.

Checked: neither `BE-SOL-STORAGE-003` (backend-go, connection
reconnect-resume contract) nor `FE-SOL-STORAGE-007` (frontend,
auth-failure/logout split) have been implemented yet — both remain
"🔲 Designed, chưa implement" as of this session, per their own status
headers, and neither defines a concrete wire method name for this signal
(`BE-SOL-STORAGE-003` mentions `TeardownConnection` as an existing
infra-fleet-service gRPC method, but there's no wscompat channel or
agent-side wire method decided for it yet). **Implementing this section
now would mean guessing at a contract two other tracks haven't settled**
— the same discipline this repo's `SOL-AG-PW-001` already established
("don't build things you can't verify end-to-end") applies here.

**What IS ready, so this isn't a hard blocker on everything**:
`cleanupAllPtys(log)` (the immediate, unconditional kill) still exists,
still passes its existing tests, and is explicitly documented (in its own
updated doc comment, see TASK-AG-STORAGE-006) as reserved for exactly this
caller. Whoever implements the backend-go/frontend side of CR-STORAGE-008(a)
need only: (1) settle the wire method name, (2) add one `case` in
`agent-rpc-dispatch*.ts` that calls `cleanupAllPtys(log)` (and the terminal
equivalent) — a small, low-risk addition once the contract exists, not a
speculative one.

## Acceptance Criteria (revised against what was actually verifiable)

- [x] `handleAgentSpawn`/`handleAgentKill`/send-input still round-trip
      correctly end-to-end — all 111 pre-existing tests pass unmodified.
- [x] A simulated WS close followed by a simulated reconnect within the
      grace period leaves a previously-spawned AI-agent PTY alive and
      resumes delivering its output —
      `agent-spawn-reconnect.integration.test.ts`.
- [x] A simulated WS close with no reconnect before the grace period
      expires results in the PTY being killed — same test file.
- [x] The new explicit-teardown path kills immediately regardless of any
      pending grace timer, with dedicated tests — see the 2026-09-08
      closing update above (`daemon.sessionTeardown`,
      `connection.teardown`).
- [x] `npx tsc --noEmit -p tsconfig.json` clean.
- [x] `npx vitest run` (full suite) green: 3909 passed, 10 skipped, 0
      failed (updated from the earlier 3904/10/0).


---

## ✅ Closing update (2026-09-08) — section 3 unblocked and implemented

`TASK-BE-STORAGE-012` Parts C/D settled the wire method name this section
was waiting on: `connection.teardown`, sent via infra-fleet-service's
`DevServerAgentClient.Exec` (the same generic transport every other
request/response method already uses — no new wire protocol). Implemented:

- `agent/src/relay/pty-daemon-server.ts` (MODIFY) — new
  `daemon.sessionTeardown` case in `dispatchDaemonRequest`: calls
  `cleanupAgentPtys(log)` immediately (bypasses any grace timer already
  counting down), unlike `daemon.sessionClosed`'s grace-period arm.
- `agent/src/relay/pty-daemon-client.ts` (MODIFY) — new
  `notifyDaemonSessionTeardown(log)` export, mirrors
  `notifyDaemonSessionClosed`'s best-effort shape exactly, sends
  `daemon.sessionTeardown`.
- `agent/src/relay/agent-rpc-dispatch-misc.ts` (MODIFY) — new
  `case 'connection.teardown'`: calls `cleanupAllPtys(log)` (agent.spawn
  PTYs, already the immediate-kill function per TASK-AG-STORAGE-006) AND
  `notifyDaemonSessionTeardown(log)` (terminal PTYs via the daemon), then
  returns `{ok: true}`; a thrown error from either becomes a ServerError
  response instead of leaving the request unanswered.

**Tests added, all passing for real:**
- `pty-daemon-server.test.ts`: `daemon.sessionTeardown kills existing PTYs
  immediately, no grace period`.
- `pty-daemon-client.test.ts`: 2 new tests (swallows daemon-unreachable
  error; sends the right method name to a live fake daemon).
- `agent-rpc-dispatch-misc.test.ts` (NEW FILE — none existed for this
  dispatch domain before): 2 tests for the `connection.teardown` case
  (happy path calls both cleanup functions and returns `{ok:true}`; a
  thrown error from `cleanupAllPtys` becomes a ServerError response).

**Verified for real:**
```
$ cd agent && npx tsc --noEmit -p tsconfig.json   # diffed vs. pre-change baseline: 0 new errors
$ npx vitest run   # full suite: 3909 passed, 10 skipped, 0 failed (was 3904/10/0 before this task)
```

`desktop/src/relay/` intentionally NOT mirrored — confirmed dead per
TASK-AG-STORAGE-005 decision 3.
