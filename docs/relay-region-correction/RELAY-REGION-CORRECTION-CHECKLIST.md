# Relay region correction — implementation checklist

> **Scope: idle-only correction.** Superseded retention history is preserved in
> `.tmp/idle-cutover-review/checklist-history-before-final.md` and the backup branch.
> Follow [idle-cutover plan](RELAY-REGION-CORRECTION-IDLE-CUTOVER-PLAN.md).

## Idle-only implementation tracker

- [x] Resolve plan review findings and obtain Astra approval (revision 2).
- [x] Preserve pre-rescope revision on `relay-region-before-idle-implementation`.
- [x] Endpoint authentication and incarnation check: deterministic red/green.
- [x] Worker selects before cutover; busy deferral and lost reply tests: red/green.
- [x] Source barrier covers accepts, attaches, commands and control replacement (48 registry tests, including conflicting operation-ID authority tuples; red/green evidence in acceptance).
- [x] Constrained assignment commit and locked ambiguous-outcome reconciliation (11 PostgreSQL 16 tests on 55440, including both replacement orders and a lost commit reply).
- [x] Desktop removes live-retention handling, retains fresh decisions and fallback (53 focused desktop/compatibility tests; node typecheck passes).
- [x] Remove superseded cloud retention protocol/store/cleanup and obsolete tests. The legacy database capability column remains written as0 for existing schema compatibility; it enables no behavior.
- [x] Real two-cell transport: two clients, quiet connection, idle move, arrival race, and observed target-registration failure with ordinary recovery (3 tests pass).
- [x] Focused PostgreSQL transaction/concurrency checks on 55440 (11 passed).
- [x] Full local relevant cloud/desktop suites: 682 cloud tests with PostgreSQL,177 desktop relay tests,16 transport/compatibility tests.
- [x] Local pinned-wire compatibility, Docker SSH/folder continuity (7), types, lint and reliability manifest. Packaged/device/platform gates remain open.
- [x] Fifth Astra low implementation audit: APPROVE within the documented scope.
- [ ] Rewrite and validate cloud/desktop PRs, CI and final acceptance evidence.

These are merge-readiness tasks. Device/package/platform and production rollout
requirements remain explicit gaps until independently evidenced.



Current transport disposition: **the replacement idle-only transport suite is green
(3 tests), but the PRs are not ready**. Local cloud/desktop verification, final implementation audit, SSH/folder evidence
and reliability docs are complete. PR updates, fresh CI and release evidence remain.
The full cloud suite passes682 tests with PostgreSQL16 and no skips; cloud typecheck passes. Final audit and remaining end-to-end/PR tasks are still open. Exact commands/results are at the top of the acceptance document. The original
live-retention rollback assertion is superseded by the approved product rescope;
these results do not claim that old design was repaired.

## Publication and release gates

- [x] Prepare separate cloud/desktop patches and concrete PR descriptions locally.
- [x] Reproduce and address old CI failures: fetch audit count and cloud test dependencies.
- [ ] Obtain authorization to publish under the original no-push handoff constraint.
- [ ] Update cloud draft20037 and desktop draft20031; verify exact-head CI.
- [ ] Packaged mixed-version desktop/mobile and physical-device lifecycle.
- [ ] Linux/Windows transport evidence, CI soak, bounded rollout and measured benefit.

No production mutation or deployment occurred. Local passing tests and audit approval
are not a claim that the current published PRs are ready or the feature is deployed.
The acceptance document lists commands, evidence scope and remaining gaps.
