# TASK-AG-STORAGE-008: Align agent-spawn PTY grace-period with backend-go's `connections.grace_period_seconds`

**Task ID:** TASK-AG-STORAGE-008
**Priority:** 🟡 MEDIUM
**Solution Ref:** [SOL-AG-STORAGE-003](../solutions/SOL-AG-STORAGE-003-agent-spawn-pty-daemon-grace-period.md) §2 step 3
**Estimated effort:** Small
**Dependencies:** TASK-AG-STORAGE-006 (the new grace-period constant must exist), coordinated with `BE-SOL-STORAGE-003`'s implementation (backend-go track — cross-repo)
**Status:** ✅ Done (2026-09-08) — cross-check completed now that backend-go shipped the real value

---

## Context

The existing terminal-PTY grace period is `PTY_GRACE_PERIOD_MS = 120_000`
(120s), sized deliberately to cover a full agent process restart. The
backend-go design (`BE-SOL-STORAGE-003`) proposes
`connections.grace_period_seconds` defaulting to 300s for deciding when a
`degraded` connection becomes `closed`. `SOL-AG-STORAGE-003` §2 step 3
flagged that these two windows are conceptually different but **must not
have the agent-local window be longer than the backend-go window** — if
backend-go still considers a connection `degraded` (recoverable) while the
agent has already killed the AI-agent PTY locally, the two sides disagree
about whether the work is resumable.

## What to do

1. Confirm the actual value backend-go ships for
   `connections.grace_period_seconds` once `BE-SOL-STORAGE-003` is
   implemented (do not assume 300s stays the final number — check the
   real migration/config at implementation time).
2. Set the new AI-agent-CLI-PTY grace period (introduced in
   TASK-AG-STORAGE-006) to a value **less than or equal to** backend-go's
   value, converted to milliseconds. Reuse the existing terminal-PTY
   `PTY_GRACE_PERIOD_MS = 120_000` as the default **unless** the product
   decision from `SOL-AG-STORAGE-003` §3 (AI-agent CLI sessions being more
   expensive to lose than a shell) argues for a longer one — if so, it
   still must stay ≤ backend-go's window; raise backend-go's window first
   (coordinate with the backend-go track) if a longer agent-side window is
   truly wanted.
3. Add a code comment at the new constant's definition site explaining the
   cross-service constraint (mirroring the existing comment style at
   `pty-agent-bridge.ts`'s `PTY_GRACE_PERIOD_MS` definition), so a future
   change to one side without checking the other is less likely.
4. If the two values are found to already be safely related (agent ≤
   backend-go) with no code change needed, still add the cross-reference
   comment — the goal is making the coupling visible, not just correct
   today.

## Acceptance Criteria

- [ ] Agent-side grace-period constant for AI-agent CLI PTYs is
      confirmed ≤ backend-go's `grace_period_seconds` (in equivalent
      units), with the actual backend-go value cited by file:line/migration
      reference, not assumed.
- [ ] A code comment at the constant's definition site cross-references
      the backend-go constraint explicitly.
- [ ] `npx tsc --noEmit` clean (should be a no-op change to type-check
      unless the constant's value changed).

## Not in scope

- Changing backend-go's `grace_period_seconds` value — that's the
  backend-go track's call; this task only reads it and conforms.


---

## 🟡 Completion Notes (2026-09-07)

`AGENT_SPAWN_PTY_GRACE_PERIOD_MS = 120_000` was added in
`agent/src/relay/agent-spawner.ts` as part of TASK-AG-STORAGE-006 — set to
the same value as `pty-agent-bridge.ts`'s existing `PTY_GRACE_PERIOD_MS`
(same worst-case rationale: survive a full agent process restart), with a
doc comment explicitly cross-referencing this task and the constraint that
it must stay ≤ backend-go's `grace_period_seconds` once that exists.

**What could NOT be done**: step 1 ("confirm the actual value backend-go
ships for `connections.grace_period_seconds`") — checked
`backend-go/services/infra-fleet-service/` for real; that column/constant
does not exist yet. `BE-SOL-STORAGE-003` (which proposes it, defaulting to
300s) is still "🔲 Designed — chưa implement" — there is no real value to
compare 120_000ms against yet. This task cannot be fully closed until that
lands; re-open and re-verify the inequality (agent's 120s ≤ backend-go's
value) once it does, per this task's own step 2 instruction.

## Acceptance Criteria (partial)

- [ ] ~~Agent-side grace-period constant confirmed ≤ backend-go's
      `grace_period_seconds`~~ — cannot verify, backend-go value doesn't
      exist yet.
- [x] Code comment at the constant's definition site cross-references the
      backend-go constraint explicitly (`agent-spawner.ts`, on
      `AGENT_SPAWN_PTY_GRACE_PERIOD_MS`).
- [x] `npx tsc --noEmit` clean (constant addition only, verified as part of
      TASK-AG-STORAGE-006's typecheck run).


---

## ✅ Closing update (2026-09-08)

`backend-go/services/infra-fleet-service/migrations/0014_connections_grace_period.up.sql`
confirms the real shipped value: `connections.grace_period_seconds INTEGER
NOT NULL DEFAULT 300`, backed by `domain.Connection.GracePeriodSeconds`
(`internal/domain/connection.go`), with real tests
(`connection_test.go`) exercising exactly `GracePeriodSeconds: 300`.

**Inequality confirmed**: agent's `AGENT_SPAWN_PTY_GRACE_PERIOD_MS =
120_000` (120s) ≤ backend-go's `grace_period_seconds` (300s). ✓ No code
change needed — the agent-side value was already safely under the
backend-go window; this task's remaining step was purely confirming that,
which is now done. Task closed.
