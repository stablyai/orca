# Independent implementation review

Verdict: **REVISE**. Reviewed the current uncommitted implementation against the plan and API contract on 2026-09-10. No production operations or source edits performed. This review identifies two concrete blockers; it does not approve deployment.

## P1 — Target recovery can replace the retained source before rollback notification

Evidence: `src/main/runtime/relay/relay-origin-pool.ts:218` only checks retention when the resolved assignment matches the origin currently being recovered. The different-origin branch at line 244 calls `activateTarget`; line 276 creates a new origin and line 279 opens a fresh control. It never checks whether another retained origin already owns that destination. `cloud/apps/relay/src/host-session-registry.ts:887` requires a resume secret for same-generation rebind; a fresh origin therefore takes a new generation. The existing-session replacement path at line 1106 closes all existing splices.

Concrete sequence:

1. Optional migration reaches target registration while a phone remains connected through retained source A.
2. Target B fails. Its active-control close starts normal director recovery.
3. Durable failed-target cleanup rolls assignment back to A at a newer epoch.
4. A recovery request for B returns that A assignment before A's next heartbeat delivers `region-restored` (or while that notification is delayed).
5. The pool opens a fresh A origin rather than waiting for/reusing retained A. The source accepts the authoritative new assignment, replaces its generation and closes the phone's original splice.

The authority-version fence does not prevent this ordering: only receipt of the restoration notification increments that fence. The separate restoration handler correctly preserves the generation when it runs first, but this recovery entry point bypasses it. Existing restoration tests exercise notification-first and late-target completion, not director-rollback-first recovery.

Smallest correction: before any fresh-origin activation, recognize a destination already represented by a retained live origin and route through exact retained restoration reconciliation. Do not use fresh-generation fallback for that destination while preservation is possible. Add an oracle where the target closes and director returns the rollback epoch before any restoration message; assert no third origin/new source generation and continued traffic on the original source splice.

## P2 — The ten-candidate claim page can starve healthy hosts in the other direction

Evidence: `cloud/apps/relay/src/assignment-store.ts:5579` limits candidates to ten, ordered by decision issuance time. Capacity and cell-safety checks happen later in `startRegionalRehomeCandidate`; no-headroom returns at line 5891. The loop at line 5591 simply continues after rejection. After ten rejections, line 5619 charges a skipped dispatch tick but does not advance a candidate cursor or defer those rows.

Concrete sequence: the ten oldest otherwise eligible decisions request Asia-to-US while US cells have no reservation headroom. The eleventh requests US-to-Asia with available Asia capacity. Every claim call selects the same first ten, rejects them for headroom, then stops. The healthy reverse-direction candidate never receives consideration until earlier decisions expire or conditions change. This is inherited structure, but the reviewed plan explicitly requires fair progress in the ten-row candidate lane. Fairness changes in `refreshRegionalRehomeLeases` cover a different lane.

Smallest correction: make rejected-candidate traversal fair without modifying evidence timestamps or spending durable failure budget. Use bounded traversal/defer state, or apply the relevant full eligibility checks before the page limit. Test more than ten candidates with blocked targets in one direction and a claimable candidate in the other.

## Coverage and remaining limits

Read the durable decision exchange, SQL retention/restoration authorization, capability binding, candidate/rollback/cleanup paths, preview aggregation, API negotiation, desktop refresh/origin retirement/recovery and cell heartbeat changes. The design is largely implemented using existing mechanisms; the findings do not require replacing it.

This was an independent source review, not an independent rerun of the full test suite. The coordinator was running actual PostgreSQL tests; no competing PostgreSQL run was started. The transport-test worker was still modifying its harness. No claim of complete test coverage, mobile-app validation or deployed behavior is made here. Final acceptance still needs the requested real traffic, mixed-version and actual PostgreSQL evidence after fixes.

Documentation discrepancy: API.md still says the low-level cohort default is 100, while the reviewed constructor correctly defaults to 0. Update the API note before handoff.

Review snapshot: HEAD `027acb4efa2e6b226d40df266b86367423946d62`; uncommitted SHA-256 digests:

- `relay-origin-pool.ts`: `806e926b9bb36a663ed4d449f00a59296c9f8a5698c585e634183a92f93b854d`
- `assignment-store.ts`: `32ea941a0855bc315cde3c63ce4a964d52e05384d13db92f195ac98858c2182f`
- `host-session-registry.ts`: `cfad6ffb7ca8de5ecefdc0fa013e4d8a88bc62a3e7e3a1f3c660ae56bee8a919`

## Fix review — 2026-09-10

**APPROVE the corrections to both findings; no remaining P1/P2 blocker found in this follow-up source review.** This supersedes the initial REVISE verdict for the reviewed findings, and remains an implementation review rather than deployment approval.

- P1 resolved: `relay-origin-pool.ts:274` rejects fresh activation whenever the destination belongs to a retained origin, before creating an origin or opening a socket. Existing retry and authenticated restoration paths then wait for/reuse the preserved source. `relay-origin-retention.test.ts:173` explicitly delivers target-close/director-rollback before the restoration notification and asserts two origins, unchanged basis control and no source close/rebind. Independently ran `ORCA_BACKGROUND_LAUNCH=1 pnpm exec vitest run src/main/runtime/relay/relay-origin-retention.test.ts`: **11 tests passed, zero skips**. The larger real transport rollback test is still being completed by its owner; its eventual result is not claimed here.
- P2 resolved: `assignment-store.ts:5536` orders the bounded candidate lane by separate durable `last_considered_at`; line 5566 advances visited candidates after assignment-first evaluation. This preserves issuance/expiry evidence and moves capacity-blocked hosts behind unvisited candidates. `regional-rehome-store.test.ts:40` sets up ten blocked hosts and an eleventh eligible reverse-direction host, asserting the subsequent tick claims the latter. The schema initializes traversal state to zero. Source review confirms the demonstrated starvation sequence is addressed; the coordinator reports its passing full PostgreSQL-configured relay run. I did not duplicate that run.

Also rechecked preview and outcome telemetry. Preview remains read-only and uncapped, includes cohort/capability/basis/capacity/safety checks, and documents its separately read advisory snapshot and rate/control limitations. Outcomes expose aggregate cell pairs/counts/ages/reservations, not identity or credential fields. Sampled decision telemetry uses host digests. No new blocker found. The aggregate preview duplicates some eligibility expressions rather than sharing a single implementation; parity checks remain worthwhile maintenance coverage, but this review found no concrete materially wrong capacity predicate.

Verification limits remain: no deployment behavior verified, and full real-transport/mobile/mixed-version evidence must be recorded by the coordinator before claiming end-to-end completion. Current store SHA-256 at this follow-up: `ae4663e13b4041fdb364d3d127c8a2cfc405353aa51c89f6a10df2700c1912fc`.

Subsequent coordinator evidence update: the transport owner completed **2 real WebSocket tests in 75 seconds**, including retention beyond 6h31m, failed target rollback, first corroboration 503 with 150s retry, original source socket/generation preservation and exactly one mutation execution. Coordinator also reports 188 shipping desktop tests and 101 final targeted tests with actual PostgreSQL passing after formatting/schema migration. These are attributed test results, not independent reruns by this reviewer; they satisfy the previously pending transport evidence for these fixes.
