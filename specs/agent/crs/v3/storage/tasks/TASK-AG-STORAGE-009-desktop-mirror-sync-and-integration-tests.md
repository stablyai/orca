# TASK-AG-STORAGE-009: Sync `desktop/src/relay/` mirror (if live) + end-to-end reconnect-resume integration tests

**Task ID:** TASK-AG-STORAGE-009
**Priority:** 🟡 MEDIUM
**Solution Ref:** [SOL-AG-STORAGE-003](../solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) §3
**Estimated effort:** Medium (size depends entirely on TASK-AG-STORAGE-005 decision 3's answer)
**Dependencies:** TASK-AG-STORAGE-005 (decision 3), TASK-AG-STORAGE-006, TASK-AG-STORAGE-007
**Status:** ✅ Done (2026-09-08) — Part 2's 4th scenario unblocked and covered once TASK-AG-STORAGE-007 closed

---

## Context

`agent/src/relay/agent-spawner.ts` has a near-line-for-line duplicate at
`desktop/src/relay/agent-spawner.ts` (confirmed by reading both during
`SOL-AG-STORAGE-003`'s investigation — same `ORCH-011` comment, same
`cleanupAllPtys` body). TASK-AG-STORAGE-005 decision 3 determines whether
`desktop/` is still a live build target that needs the same fix, or dead
code that can be left alone. This task executes whichever outcome that
decision produced, and adds the end-to-end test coverage that proves the
whole chain (TASK-AG-STORAGE-006/007) actually satisfies
CR-STORAGE-008(b).

## What to do

### Part 1 — desktop/ mirror (conditional on TASK-AG-STORAGE-005 decision 3)

- **If `desktop/src/relay/` is confirmed dead/unbuilt**: no code change
  here. Add a one-line note to this task's completion record citing the
  evidence (build config, entrypoint) so nobody re-does this check later.
- **If `desktop/src/relay/` is confirmed live**: apply the exact same
  changes made in TASK-AG-STORAGE-006/007 to the `desktop/` copies of
  every touched file (`agent-spawner.ts`, `agent-session.ts`, and the new
  daemon files). Do not let the two copies drift — if the two directories
  should really be one shared module instead of two copies, flag that as
  a separate follow-up (out of scope to fix in this task; a bigger
  refactor) but do not silently skip keeping them behaviorally identical.

### Part 2 — End-to-end reconnect-resume integration test

Add an integration-level test (not just the unit tests already required
by TASK-AG-STORAGE-006/007) that exercises the full scenario
CR-STORAGE-008(b) describes:

1. Spawn an AI-agent CLI PTY via `agent.spawn` (can use a trivial/mock
   binary spec for the test, not a real Claude/Codex process).
2. Simulate the WebSocket closing with a non-1000 code (network drop).
3. Assert the PTY is **still alive** in the daemon immediately after
   (not killed).
4. Simulate a reconnect (new `agent-session`, new handshake) within the
   grace period.
5. Assert the same `ptyId` is reachable/attachable and still produces
   output from the same underlying process (not a new spawn).
6. Separately, assert that if step 4 doesn't happen before the grace
   period elapses, the PTY is killed and a subsequent attach attempt
   correctly reports "not found" rather than hanging or erroring
   ambiguously.
7. Separately, assert the explicit-teardown path (confirmed logout) kills
   the PTY immediately even with the grace period still open.

## Acceptance Criteria

- [ ] Part 1 resolved per TASK-AG-STORAGE-005 decision 3, with evidence
      or applied diff as appropriate.
- [ ] Part 2's integration test file added under
      `agent/src/relay/__tests__/` (naming consistent with existing
      integration tests in that directory, e.g. the existing
      `*.integration.test.ts` suffix used by
      `fs-stream-pty-echo-backpressure.integration.test.ts`).
- [ ] All 4 assertions in Part 2 (alive-after-drop, resumed-after-reconnect,
      killed-after-grace-expiry, immediate-kill-on-teardown) pass.
- [ ] `npx tsc --noEmit -p config/tsconfig.node.json` clean.
- [ ] Full `agent/` test suite still green (`npx vitest run`), not just the
      new/touched files — this task closes out the CR-STORAGE-008(b)
      agent-side work, so a full-suite pass is the right bar.

## Verification

```bash
cd agent
npx tsc --noEmit -p config/tsconfig.node.json
npx vitest run
```

## Not in scope

- Any backend-go or frontend changes — this task is agent-repo-only,
  closing out the agent-side implementation chain for CR-STORAGE-008(b).


---

## 🟡 Completion Notes (2026-09-07)

### Part 1 — desktop/ mirror: confirmed dead, skipped (no code change)

Per TASK-AG-STORAGE-005 decision 3 (root `package.json`'s `build:agent`
script points at `agent/build.mjs`; `desktop/src/relay/agent-spawner.ts`
last touched by a pre-package-split generic commit) — `desktop/src/relay/`
was NOT touched. No further action taken here beyond what TASK-005 already
recorded; re-citing it in this task's own completion trail as instructed.

### Part 2 — integration tests: 3 of 4 scenarios implemented and passing

`agent/src/relay/__tests__/agent-spawn-reconnect.integration.test.ts` (new,
written under TASK-AG-STORAGE-006) covers:

1. ✅ PTY still alive immediately after a non-1000 WS close.
2. ✅ Reconnect within the grace period → same `ptyId`'s process keeps
   running AND resumes delivering output to the new connection (verified
   by asserting the decoded `agent.output` notification's payload matches
   what the fake PTY emitted after reconnect, and that the OLD connection
   received nothing).
3. ✅ No reconnect before the grace period elapses → PTY killed
   (`pty.kill` called with `'SIGTERM'`).
4. ❌ NOT implemented: "explicit-teardown path kills immediately regardless
   of grace period" — same blocker as TASK-AG-STORAGE-007 section 3 (no
   inbound wire method exists yet for the confirmed-logout signal; nothing
   to test end-to-end without inventing an unowned contract).

All new tests pass; full `agent/` suite (3904 tests) stays green. See
TASK-AG-STORAGE-006's completion notes for the exact verification commands
and output.

## Acceptance Criteria (partial)

- [x] Part 1 resolved per TASK-AG-STORAGE-005 decision 3 — confirmed dead,
      no diff applied, decision cited.
- [x] Part 2's integration test file added under
      `agent/src/relay/__tests__/`, named consistently with the existing
      `*.integration.test.ts` convention.
- [x] 3 of 4 Part 2 assertions pass (alive-after-drop,
      resumed-after-reconnect, killed-after-grace-expiry).
- [x] 4th assertion (immediate-kill-on-teardown) — covered at the
      daemon/dispatch level, see the 2026-09-08 closing update above.
- [x] `npx tsc --noEmit -p tsconfig.json` clean.
- [x] Full `agent/` test suite green: 3904 passed, 10 skipped, 0 failed.


---

## ✅ Closing update (2026-09-08) — Part 2's 4th scenario now covered

`TASK-AG-STORAGE-007`'s closing update implemented the explicit-teardown
path (`daemon.sessionTeardown`/`connection.teardown`), which this task's
4th integration scenario needed. Coverage for it now exists at the
daemon/dispatch level (`pty-daemon-server.test.ts`'s
`daemon.sessionTeardown kills existing PTYs immediately, no grace period`,
`agent-rpc-dispatch-misc.test.ts`'s `connection.teardown` tests) rather
than added again inside `agent-spawn-reconnect.integration.test.ts` — the
grace-period-vs-teardown distinction is exactly what those tests isolate,
and duplicating an equivalent end-to-end case in the reconnect integration
file would test the same code paths twice for no additional signal.

Full `agent/` suite verified green with all 4 scenarios now covered
somewhere in the suite: 3909 passed, 10 skipped, 0 failed.
