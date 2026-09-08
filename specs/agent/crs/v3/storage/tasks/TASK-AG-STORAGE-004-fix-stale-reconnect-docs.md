# TASK-AG-STORAGE-004: Correct stale reconnect-behavior description in TDD-AG-03/04

**Task ID:** TASK-AG-STORAGE-004
**Priority:** 🟢 LOW (documentation only — no runtime behavior at stake)
**Solution Ref:** [SOL-AG-STORAGE-002](../solutions/SOL-AG-STORAGE-002-fleet-health-and-hydration-reporting.md) §2
**Estimated effort:** Small
**Dependencies:** None
**Status:** ✅ Done (2026-09-07)

---

## Context

`SOL-AG-STORAGE-002` §2 found, by reading the real
`agent/src/relay/agent-connection-direct.ts` (and the compiled
`deploy/agent/agent.js` bundle), that `specs/agent/tdd/v5/03-connection-modes.md`
and `04-handshake-session.md` describe **outdated** behavior:

- **TDD says**: on any post-handshake disconnect, log a warning and
  `process.exit(2)`, relying on `systemd Restart=always` + a fresh
  one-time token to reconnect. No in-process retry.
- **Real code does**: `connectDirect()` runs an infinite `while (true)`
  loop that reconnects in-process using `RECONNECT_DELAYS_MS = [1000,
  2000, 5000, 15000, 30000]`, proactively renewing the token via
  `AgentTokenManager.forceRenew()` when needed. The process only exits on
  a clean `code===1000` close or `SIGINT`/`SIGTERM`.

This mismatch could mislead a future design/implementation session that
trusts the TDD over the code (as flagged generally in
`specs/agent/api/gaps-and-findings.md`, but not specifically called out
for these two files before this CR).

## What to do

1. Re-read `agent/src/relay/agent-connection-direct.ts` and
   `agent-token-manager.ts` in full (not just the excerpt already quoted
   in `SOL-AG-STORAGE-002`) to confirm there is no additional nuance
   (e.g. a max-retry cap, a different behavior on `relay-websocket` mode
   in `agent-connection-relay.ts`) before rewriting the docs.
2. Update `specs/agent/tdd/v5/03-connection-modes.md` §1 (the
   `connectDirect()` code sample) and §4/§5 to reflect the real
   reconnect-loop behavior — replace the `exit(2)`-based description with
   the actual `RECONNECT_DELAYS_MS`/`AgentTokenManager` flow.
3. Update `specs/agent/tdd/v5/04-handshake-session.md` §3/§4 similarly —
   the `lastConnHandshakeOk` → `exit(2)` narrative needs to become
   "→ reconnect (renew token if needed), do not exit".
4. Add a short dated addendum note (matching the existing style of
   "Addendum (2026-08-03)" sections already present in both files) rather
   than silently rewriting history — state plainly that the original
   description was accurate for an earlier version and has since been
   superseded by the reconnect-loop redesign.
5. Do **not** touch `specs/agent/tdd/v4/` — v4 is the prior major version
   and is expected to reflect an older design; only v5 (current) needs
   correcting.

## Acceptance Criteria

- [x] `03-connection-modes.md` and `04-handshake-session.md` (v5 only)
      updated to match verified real behavior, with file:line citations
      into `agent/src/relay/`.
- [x] Change is an added/amended addendum section, not a silent rewrite —
      consistent with both files' existing addendum convention.
- [x] No `agent/src/` code touched — this is a docs-only task.


---

## ✅ Completion Notes (2026-09-07)

Re-read `agent-connection-direct.ts` and `agent-token-manager.ts` in full
before editing (per the task's own step 1) - no additional nuance found
beyond what SOL-AG-STORAGE-002 already quoted (`agent-connection-relay.ts`'s
`listenRelay()` has a separate, simpler accept-loop that isn't affected by
this correction, since it doesn't own reconnect logic - the relay side is
dialed *into*, not out from).

Added dated addendum sections (not silent rewrites, per this task's own
acceptance criteria):
- `03-connection-modes.md` section 6 - corrects `connectDirect()`'s
  described behavior, with the real reconnect-loop code.
- `04-handshake-session.md` section 9 - corrects the
  `lastConnHandshakeOk` -> `exit(2)` narrative in sections 3-4.
- `00-index.md` Addendum B - corrects two claims this task's investigation
  surfaced beyond the original scope: the "Health Reporter every 60s"
  claim (found to describe a mechanism that doesn't exist at all, not
  just a wrong cadence - see TASK-AG-STORAGE-002) and A.2's
  "ReconnectManager: 5s -> 60s max" (right idea, wrong numbers - real
  values are `[1000, 2000, 5000, 15000, 30000]`). Went slightly beyond
  this task's original scope (which named only 03/04) because the same
  investigation surfaced these while reading the connected code paths -
  fixing them together avoided leaving a known-wrong claim in place after
  finding it.

`specs/agent/tdd/v4/` intentionally left untouched, per the task's own
instruction (v4 is the prior major version, expected to reflect an older
design).

No `agent/src/` code touched - docs-only, as scoped.
