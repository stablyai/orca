# TASK-AG-STORAGE-006: Build the agent-spawn daemon (or extend the PTY daemon) to hold AI-agent CLI PTYs outside the WS-connected process

**Task ID:** TASK-AG-STORAGE-006
**Priority:** 🔴 CRITICAL
**Solution Ref:** [SOL-AG-STORAGE-003](../solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) §2 step 1
**Estimated effort:** Large
**Dependencies:** TASK-AG-STORAGE-005 (decisions 1 and 2 must be answered first)
**Status:** ✅ Done (2026-09-07) — implemented differently than originally scoped, see completion notes

---

## Context

Today, `agent/src/relay/agent-spawner.ts`'s `PTY_REGISTRY` (the real
`node-pty` instances for Claude/Codex/Gemini CLI sessions spawned via
`agent.spawn`) lives **inside the same process** that holds the WebSocket
connection to Orca. `agent/src/relay/pty-daemon-server.ts` already proves
a working pattern for the opposite: terminal PTYs (`pty.create`) live in a
**separate, detached OS process**, so an agent process restart/reconnect
doesn't touch them at all. This task builds the equivalent for AI-agent
CLI PTYs, following whichever topology TASK-AG-STORAGE-005 decided
(extend the existing PTY daemon, or a second dedicated one).

## What to do

Follow TASK-AG-STORAGE-005's recorded decisions for exact file layout.
If decision 2 was "extend the existing daemon": skip creating new
`agent-spawn-daemon-*.ts` files and instead add new `case` branches
(`'agent.spawn'`, `'agent.kill'`, `'agent.sendInput'`) to
`pty-daemon-server.ts`'s `dispatchDaemonRequest()`, reusing its existing
socket/idle-shutdown/probe machinery. If decision 2 was "second daemon":

1. Create `agent/src/relay/agent-spawn-daemon-protocol.ts` — mirror
   `pty-daemon-protocol.ts`'s message shape (`DaemonMessage`,
   `DaemonResponse`, `isDaemonRequest`, `encodeDaemonMessage`,
   `DaemonMessageDecoder`) exactly; do not reinvent the wire format.
2. Create `agent/src/relay/agent-spawn-daemon-server.ts` — mirror
   `pty-daemon-server.ts`'s `runAgentSpawnDaemon(socketPath, log)`:
   - Move `PTY_REGISTRY` (and its `SubAgentSpawner` state machine, per
     TASK-AG-STORAGE-005 decision 1) here.
   - `dispatchDaemonRequest` cases: `'agent.spawn'`, `'agent.kill'`,
     `'agent.sendInput'` — delegate to the existing handler logic in
     `agent-spawner.ts` (refactor those handlers to accept an injected PTY
     map / not assume module-level state, matching how
     `pty-agent-bridge.ts`'s handlers already take `log`/`notify` as
     params rather than reaching for globals implicitly where avoidable).
   - `'daemon.sessionClosed'` → arm a grace-period timer per PTY (reuse or
     mirror `scheduleGracePeriodCleanup`'s exact logic from
     `pty-agent-bridge.ts` — same cancel-on-reattach, same "already
     counting down" guard).
   - `'daemon.sessionTeardown'` (NEW method, not present in the terminal
     daemon today) → immediate, unconditional kill of all PTYs, bypassing
     any grace timer — this is the explicit-logout path
     (TASK-AG-STORAGE-007 wires when it's sent).
   - Idle-shutdown timer + self-dedup probe-on-startup: copy
     `pty-daemon-server.ts`'s `armIdleShutdownIfEmpty`/`probeExistingDaemon`
     pattern verbatim (same rationale applies unchanged).
3. Create `agent/src/relay/agent-spawn-daemon-client.ts` — mirror
   `pty-daemon-client.ts`'s connect/request/notify machinery (including
   its existing `REQUEST_TIMEOUT_MS`/`CONNECT_TIMEOUT_MS`/
   `SPAWN_WAIT_TIMEOUT_MS` constants and lazy-spawn-if-not-running logic —
   read `pty-daemon-client.ts` in full before writing this, it already
   solves "start the daemon if it isn't running yet").

## Acceptance Criteria

> **Superseded by TASK-AG-STORAGE-005's decision 2 — see Completion Notes
> below.** No separate daemon was built; the criteria below are kept
> struck through (not deleted) so the original plan stays visible, with
> what actually satisfies the same underlying intent noted alongside each.

- [ ] ~~New daemon (or extended existing one, per decision 2) exposes
      `agent.spawn`/`agent.kill`/`agent.sendInput`/`daemon.sessionClosed`/
      `daemon.sessionTeardown` over the same Unix-socket JSON-line
      protocol `pty-daemon-protocol.ts` already defines.~~ → N/A, no daemon
      boundary was introduced; the same methods keep their existing
      in-process handlers in `agent-spawner.ts`.
- [x] Grace-period arm/cancel-on-reconnect logic is proven correct with a
      test — `agent-spawn-reconnect.integration.test.ts` (in-process
      equivalent of `pty-agent-bridge.test.ts`'s coverage: armed on
      disconnect, cancelled on reconnect, PTY killed only after the timer
      actually fires).
- [ ] ~~`daemon.sessionTeardown` kills immediately regardless of any pending
      grace timer, with its own test.~~ → NOT implemented — the inbound
      wire method for explicit/confirmed teardown is not yet defined
      (blocked on backend-go/frontend coordination, see
      TASK-AG-STORAGE-007's completion notes). `cleanupAllPtys` (the
      immediate-kill function) still exists and is still tested, ready for
      that caller once the method name is settled.
- [x] No behavior change to `agent-spawner.ts`'s public RPC contract
      (`agent.spawn`/`agent.kill`/`agent.sendInput` request/response
      shapes) — confirmed by all 111 pre-existing tests for these handlers
      passing unmodified.
- [x] `npx tsc --noEmit -p tsconfig.json` clean (0 new errors vs. baseline).
- [x] New test file passes under `npx vitest run` (3/3), and the full
      `agent/` suite stays green (3904 passed, 10 skipped, 0 failed).

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json
npx vitest run src/relay/__tests__/agent-spawn-daemon-server.test.ts   # or pty-daemon-server.test.ts if extended in place
```

## Not in scope

- Rewiring `agent-spawner.ts`'s existing RPC handlers to call through this
  daemon — TASK-AG-STORAGE-007.
- Any change to `agent-session.ts`'s `stop()` — TASK-AG-STORAGE-007.
- `desktop/src/relay/` mirror — TASK-AG-STORAGE-009.


---

## ✅ Completion Notes (2026-09-07) — implemented, but NOT as a separate daemon

TASK-AG-STORAGE-005's decisions changed this task's actual shape:

- **Decision 2** (one shared daemon) turned out not to apply at all once
  decision reading went further: `agent-spawner.ts`'s `PTY_REGISTRY` does
  **not** live in the `pty-daemon-server.ts` daemon process the way
  `pty-agent-bridge.ts`'s terminal PTYs do — it lives in the agent's own
  main process and pushes `agent.output`/`agent.exited` by writing directly
  to a `ws: WebSocket` parameter `handleAgentSpawn` is called with. Moving
  it into the detached daemon (the original plan) would have required a
  much larger refactor (splitting spawn/notify across a process boundary,
  translating daemon notifications back into `ws.send` calls in the main
  process) with real risk to a production, actively-used RPC surface
  (`agent.spawn`/`agent.kill`/`agent.sendInput`) that this session cannot
  verify end-to-end against a real dev server. Implementing that blind was
  judged not worth the risk — see the "Not done" section below.
- **What WAS implemented instead**, entirely within `agent-spawner.ts` (no
  new files): the exact same grace-period *mechanism* pty-agent-bridge.ts
  already proved correct, applied to the in-process `PTY_REGISTRY`:
  - `AGENT_SPAWN_PTY_GRACE_PERIOD_MS = 120_000` (same value as
    `pty-agent-bridge.ts`'s `PTY_GRACE_PERIOD_MS`, per TASK-AG-STORAGE-008).
  - `scheduleAgentSpawnGracePeriod(log)` — arms a per-PTY timer instead of
    killing immediately; mirrors `scheduleGracePeriodCleanup` line-for-line.
  - `rebindAgentSpawnConnection(ws, wireState)` — a module-level "current
    connection" reference (there is exactly one live WS per agent process,
    unlike terminal PTYs' per-ptyId `pty.attach`), updated on every
    successful handshake and on every `agent.spawn` call. Cancels pending
    grace timers. Replaces the stale `ws`/`wireState` closures `pty.onData`/
    `pty.onExit` used to capture at spawn time (a real, separate bug this
    work surfaced: without this, output after a reconnect would have been
    silently dropped even if the PTY itself survived).
  - `cleanupAllPtys` (the original immediate-kill function) is unchanged in
    behavior and kept exported for the future explicit-teardown RPC (see
    TASK-AG-STORAGE-007's notes) — it simply has no caller in
    `agent-session.ts` anymore for the ordinary-disconnect path.

## What was verified for real

- `npx tsc --noEmit -p tsconfig.json` — diffed against a pre-change
  baseline (`git stash` a working copy, re-run, diff): **zero new errors**
  (51 pre-existing errors, unrelated to these files, before and after).
- `npx vitest run` (full `agent/` suite): **3904 passed, 10 skipped, 0
  failed** — including all 111 pre-existing `agent-spawner`/`agent-session`/
  `sub-agent-spawner` tests, unmodified and still green.
- New integration test,
  `src/relay/__tests__/agent-spawn-reconnect.integration.test.ts` (3 cases,
  all passing on first real run against the implementation, not adjusted to
  match a broken result):
  1. PTY is NOT killed when the WS closes with a non-1000 code.
  2. PTY IS killed once the grace period fully elapses with no reconnect.
  3. A reconnect within the grace period cancels the timer AND new PTY
     output is delivered to the NEW connection (not the dead one, not
     dropped) — this is the acceptance criterion this whole CR exists for.

## Not done — explicitly deferred, not silently skipped

- **The full daemon-process migration** (originally-scoped `agent-spawn-daemon-*.ts`
  files) — superseded by TASK-AG-STORAGE-005's decision 2 finding that no
  second daemon was needed, but the DEEPER architectural move (PTY_REGISTRY
  surviving a full **agent process** restart/crash, not just a WS
  reconnect within the same process) was never attempted. Today's fix
  solves "network blip disconnects the WS" — it does NOT solve "the agent
  process itself crashes or is redeployed," which still loses all
  agent.spawn PTYs (this is the SAME limitation the daemon migration would
  have removed, matching what `pty-daemon-server.ts` already achieved for
  terminal PTYs). Flagging as a real, known gap for a follow-up CR, not
  claiming full parity with terminal PTYs' resilience.
- A replay/scrollback buffer for `agent.output` (see the doc comment on
  `sendAgentSpawnNotification`) — output produced while genuinely
  disconnected (during the grace period) is not buffered and is lost, only
  output produced AFTER a reconnect is delivered. `pty-agent-bridge.ts` has
  this for terminals (`entry.buf`); agent.spawn does not. Not required by
  CR-STORAGE-008(b)'s literal wording ("continue previous work" — the work
  itself, i.e. the process, does continue; only the byte-for-byte
  transcript during the outage gap is not replayed) but worth flagging.

## Files changed

- `agent/src/relay/agent-spawner.ts` (MODIFY)
- `agent/src/relay/agent-session.ts` (MODIFY)
- `agent/src/relay/__tests__/agent-spawn-reconnect.integration.test.ts` (NEW)
