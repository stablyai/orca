# Reviewer Checklist: inline-agents default-on migration

Any PR that touches `src/main/persistence.ts` migration logic for
`worktreeCardProperties` MUST be reviewed against every cohort below.
Tick each box only after confirming the corresponding test passes
AND the migration code's behavior matches the expected outcome.

The load-bearing migration trap is documented inline at `src/main/persistence.ts`
lines 175-220 (the TRAP comment).

## Why this checklist exists

The legacy flag `_inlineAgentsDefaultedForExperiment` was stamped on every
successful `load()` in shipped builds, regardless of the experimental
toggle. Anyone who tries to "consolidate" or "simplify" the two-flag
arrangement risks silently regressing the majority cohort (Case C) or
the deliberate-uncheck cohort (Case B). This checklist is the safety net.

## Cohorts (ALL must be verified)

### [ ] Case A — Experiment was ON, has 'inline-agents'

- **On-disk:** `experimentalAgentDashboard: true`, legacy flag `true`, `worktreeCardProperties` includes `'inline-agents'`.
- **Expected:** No-op append (already present). New flag stamped.
- **Locked by:** `it('leaves cardProps alone when inline-agents is already present', ...)`

### [ ] Case B — Experiment was ON, deliberately unchecked

- **On-disk:** `experimentalAgentDashboard: true`, legacy flag `true`, no `'inline-agents'` in `worktreeCardProperties`.
- **Expected:** Migration SKIPS (preserve uncheck). New flag stamped.
- **Locked by:** `it('preserves a deliberate uncheck from the experimental-toggle era (Case B)', ...)`
- **Why this is fragile:** legacy flag alone cannot distinguish this from Case C. The discriminator reads the deprecated `experimentalAgentDashboard` value. If anyone removes the discriminator without also removing the deprecated key from on-disk state, this regresses.

### [ ] Case B (durable) — same as B but second launch

- **On-disk:** Case B fixture plus `_inlineAgentsDefaultedForAllUsers: true`.
- **Expected:** Migration short-circuits on the new flag. Array unchanged.
- **Locked by:** `it('Case B preservation is durable across restarts', ...)`

### [ ] Case C — Experiment was OFF, untouched (the majority cohort)

- **On-disk:** `experimentalAgentDashboard: false` or absent, legacy flag `true` (stamped on every prior load), no `'inline-agents'`.
- **Expected:** Migration FIRES. `'inline-agents'` appended. New flag stamped.
- **Locked by:** `it('adds inline-agents for users who launched a prior RC with the experiment off', ...)` AND `it('adds inline-agents to persisted cardProps on first load after upgrade', ...)`
- **Why this is the regression-blocker:** this is the cohort the migration exists for. If gated on the legacy flag, this case silently does nothing.

### [ ] Case D — Experiment was OFF, "unchecked"

- Practically empty cohort (UI was hidden when experiment was off).
- Treated as Case C — append. Acceptable.

### [ ] Case E — Fresh install

- **On-disk:** none.
- **Expected:** Defaults provide `'inline-agents'` in `worktreeCardProperties`. Migration code doesn't run.
- **Locked by:** any default-state test in the suite (the default `worktreeCardProperties` in `src/shared/constants.ts` already contains `'inline-agents'`).

### [ ] Case F — Downgrade and re-upgrade

- User upgrades, then runs a prior build which spreads unknown UI keys forward, then re-upgrades.
- **Expected:** new flag survives the downgrade -> migration skips. Idempotent.
- **Locked by:** `it('Case B preservation is durable across restarts', ...)` covers the equivalent state shape.

### [ ] Lapsed Case B — experiment toggled on, unchecked, toggled off, then upgrade

- **On-disk:** `experimentalAgentDashboard: false`, no `'inline-agents'`, legacy flag `true`.
- **Expected:** Treated as Case C (row re-added). DOCUMENTED LIMITATION — the discriminator only sees the most recent value.
- **Locked by:** `it('lapsed Case B (experiment off at upgrade time) re-adds inline-agents', ...)`
- **Mitigation:** user re-unchecks once; sticks because the new flag stamps.

## Verification commands

```bash
pnpm test src/main/persistence.test.ts
```

All seven tests above must pass. If any are missing, the reviewer must add them before approving.

## Discriminator removal (cleanup release)

The Case B discriminator is one-shot — it reads `parsed.settings.experimentalAgentDashboard` only on the first load that lacks `_inlineAgentsDefaultedForAllUsers`. After two or more stable releases, the discriminator and its helper can be removed. At that point:

- Tail-end multi-version-skippers in Case B will lose preservation. They re-uncheck once, sticks. Acceptable for a small cohort that long.
- The lapsed-Case-B test can be deleted (the discriminator is gone, so there's no "discriminator misses experiment-off" to assert against).
- The Case B and Case-B-durable tests must STILL pass — the durable test exercises the steady-state new-flag gate and is independent of the discriminator.
- DO NOT proactively strip `experimentalAgentDashboard` from `parsed.settings` before the cleanup release — the discriminator depends on it round-tripping naturally.
