# Relay relocation readiness

Last updated: 2026-09-10. Scope: investigate desktop region selection and prepare the next rollout decision. Rehome must remain disabled; no cell rollout or host relocation is authorized by this investigation.

## Completed before this investigation

- PR #19915 merged as `a6e6de93c4d6d7d549068780bca8be789ef0f0a7`.
- Director deployed through run https://github.com/stablyai/orca/actions/runs/34524771144.
- Serving revision `orca-cloud-relay-00585-gaq`, image `sha256:ca587087d1a94d1636eae42acd28b2aa65c6210caba585b668bf661c4cd79efc`.
- Health/readiness passed; 100% traffic; five warm instances.
- Last authenticated observation: rehome disabled at generation 12; selector generation 192; 19 general cells ready with rehome protocol 1.
- US connection headroom was 410–431 slots per general cell. This is a dated observation, not permission to move hosts.

## Current work

- [x] Identify releases containing desktop probe fixes (#19233, #19349) and probe diagnostics (#19307).
- [x] Determine what evidence exists for adoption among affected desktops.
- [x] Assess comparison evidence: partial join completed; requested/comparative values unavailable.
- [x] Decide whether evidence supports running the production safety gate and preparing a limited rollout.

## Evidence rules

Source reads use fetched `origin/main`, because this worktree predates the fixes. No raw host IDs, pairing data, or credentials belong in this file. High RTT to Asia alone does not prove US is faster. Release availability does not prove installation. Missing telemetry remains unknown.

## Next decision

Use the existing bidirectional rehome mechanism, with explicit fresh preference eligibility and bounded rollout. See the final source investigation below; it supersedes the earlier manual-log-first next actions. No production enable is authorized or performed.

## Release findings

- GitHub latest desktop release: **v1.4.199**, published 2026-09-09 18:45:22 UTC. Its remote tag resolves to `28957d6004dd191b6f0baff493a9fd3d37405d9d` and contains all three original fix/diagnostic commits.
- **v1.4.198 is not sufficient.** Its remote tag resolves to `e0826956fcfc532f5a1e55b5e081f2e57e553c43`. Actual source lacks probe warm-up, complete-catalog protection, and the new probe-log module. This was checked beyond ancestry to exclude cherry-pick ambiguity.
- v1.4.197 also lacks these fixes.
- A local v1.4.198 tag disagreed with the remote. Remote tags were fetched into `refs/verification/releases/*` without overwriting existing tags; findings use those remote snapshots.
- Available production adoption signal: control-close logs include a hashed host digest and desktop app version. This samples closing/reconnecting sockets and must not be described as a fleet-wide installed-version census.
- Comparative probe reports are emitted through the desktop console log (`relay-region-probe-log.ts:53`); director grant logs identify assigned cell but do not include per-host requested region or comparative timings (`app.ts:333`). The application DB stores requested region, not comparative measurements. A complete three-way comparison is not established yet.

## Production adoption sample (completed)

Window: **2026-09-10 18:52–20:52 UTC**. Read GCE control-close messages (including `MESSAGE`/`message` variants) and `orca_relay_host_control_rtt`. Deduplicate each event family independently to the latest sample per hashed host digest, then join in memory. No identities or raw payloads were saved.

| Population | Count | v1.4.199 |
| --- | ---: | ---: |
| Hosts with a version-bearing control-close event | 5,409 | 2,329 (43.1%) |
| Asia hosts with an RTT event | 1,160 | Unknown for unmatched hosts |
| Asia RTT hosts also matched to a close-event version | 696 | 409 (58.8%) |
| Matched Asia hosts with RTT ≥140 ms | 178 | 84 |

Other major close-event versions: v1.4.198 = 1,321; v1.4.197 = 877. Custom/local version strings are not assumed to contain the fixes. Even the standard version string is a client-reported identifier, not binary attestation.

The version belongs to a closed socket, not necessarily the host's current connection; the RTT and close event can be at different times. This is evidence of mixed adoption, not a synchronized assignment/version census or proof of bad preference selection. The 84 updated/high-RTT hosts may simply retain their old sticky assignment; their US alternative has not been measured here.

Completeness: twelve ten-minute slices returned 18,649 rows (1,368 / 1,567 / 1,518 / 1,572 / 1,485 / 1,449 / 1,552 / 1,646 / 1,755 / 1,556 / 1,573 / 1,608). Independent hourly queries returned 8,959 + 9,690 = 18,649. No limits reached, no CLI warnings, zero unparsed close events. In-memory deduplicated input SHA-256: `5d16e9c423cc3f4eb88aeb2c64004e4194918f12e2db2c56b65994e0e1b8e9d4`.

## Decision and remaining evidence

**Do not enable fleet-wide rehome yet.** The fixes are released, but adoption is mixed and this investigation cannot demonstrate correctness of the stored preferences for the affected hosts.

- Release/source boundary: complete. v1.4.199 is the first of the checked recent releases containing all three changes; artifacts exist for macOS, Windows, and Linux.
- Adoption: sampled, with limitations above. A full installed-version census is not available from these logs.
- Assigned/requested/comparative latency join: **not established**. The assignment request sends only a preferred-region enum (`relay-http-client.ts:185`); desktop comparative reports stay in its logging path (`relay-region-preference.ts:227`, `relay-region-probe-log.ts:53`). The director's per-host grant log exposes the chosen cell but not requested region. No authenticated per-host preference inspection endpoint was identified in the checked assignment/control routes. No production SQL or private diagnostic bundle was accessed.
- Readiness was already established operationally, but that does not validate client region choices. Running the 15-minute safety gate now would not fill this evidence gap; no monitor or enable workflow was dispatched in this investigation.
- Existing rehome controls are global (rate, age, cooldown, grace), not a host/version allowlist. A rate-limited enable must not be described as a selected-host canary.
- Final authenticated check: **generation 12, enabled=false**. No production changes made this turn.

### Earlier next actions (superseded by the source investigation below)

1. Capture an affected v1.4.199 desktop's `relay_region_probe` / `relay_region_self_heal` console output, including both regional measurements and its assigned cell where emitted. Existing historical logs may not be available: the logger calls main-process `console.info` (`relay-region-probe-log.ts:53`); persistence into diagnostic exports has not been established. Use a user-controlled terminal launch and filter only these events, or an already captured console sample. Do not trigger uploads or contact users automatically. A cached event has no measurements, so inspect a refresh event; restarting alone does not invalidate the persistent cache.
2. Check a refreshed US preference against its Asia assignment, allowing for the desktop's 25 ms / 20% hysteresis and 24-hour cache. High Asia RTT by itself is insufficient.
3. Before enabling globally, quantify how many mismatch candidates still come from old clients. This needs a reviewed aggregate read path or additional observability; current control-close samples cannot answer it. Prefer aggregate evidence over exposing raw host records.
4. With validated preference evidence, either use an already-supported targeted migration procedure for the verified example, or explicitly review a global rate-limited rollout. Run the fresh production safety gate immediately before that operation and retain the durable disable procedure. Any enable/migration requires its own authorization.

No additional RTT database or cell rollout was performed or shown necessary by these findings.

### Probe log collection clarification

The standard diagnostic collector explicitly collects the trace sink and daemon lifecycle log (`src/main/observability/index.ts:226`); this is not evidence that it includes arbitrary main-process console output. Mobile settings' Copy Diagnostics copies a pairing-failure snapshot (`MobilePane.tsx:299`), not historical probe events. The earlier suggestion to obtain existing support logs overstated their guaranteed availability. No affected desktop has been restarted or its cache changed during this check.


## Final source investigation and recommended solution

Checked fetched `origin/main` at `721a2692893ab29f8daee3149965bf5e9adf99a0` on 2026-09-10. This is a source/design investigation, not a new production census or a claim that a new fix was tested or deployed.

### Material correction

**Bidirectional rehome already exists.** PR #19241, commit `f5be177e44`, precedes the deployed #19915 merge (`git merge-base --is-ancestor f5be177e44 a6e6de93c4d6d7d549068780bca8be789ef0f0a7` exited 0). Earlier conversational statements that we must build Asia-to-US rehome were wrong.

- `cloud/apps/relay/src/assignment-store.ts:5328`: candidate preference differs from assigned region, without a hardcoded direction.
- Same file `:5554`: locked recheck skips hosts already in their preferred region.
- Same file `:5603`: target region equals the stored preference.
- `regional-rehome-store.test.ts:346`: explicit Asia-to-US test; `:434` vicinity also tests cooldown before moving back. These test definitions were inspected, not rerun this turn.

### Actual gaps established by source

1. **Receipt age is not measurement age.** `assignment-store.ts:669` passes director `now` into preference storage; `:7205` onward only stores region and observed_at. A cache hit just before its 24-hour expiry can reset observed_at and remain eligible for another preference-max-age interval. No probe algorithm marker accompanies the hint (`relay-http-client.ts:185`).
2. **An inconclusive refresh does not revoke old relocation eligibility.** The resolver deliberately returns no hint when both regions cannot be compared (`relay-region-preference.ts:185` vicinity). `recordRegionPreference` returns early for undefined (`assignment-store.ts:7211`), retaining the prior region and timestamp. That row can remain eligible until its old timestamp ages out. Missing hints from old clients must remain distinguishable from an explicit new inconclusive result.
3. **Cache expiry is lazy, not a refresh schedule.** Resolver calls in broker open (`relay-session-broker.ts:211`) and drain/recovery (`relay-origin-pool.ts:164`) resolve preferences. Normal token refresh (`relay-session-broker.ts:251`) and control rebind (`relay-origin-pool.ts:237`) do not. An otherwise stable connection is not guaranteed to report a new preference after 24 hours. Thus simply waiting a day is not a fleet refresh strategy.
4. **Migration can end old connections at the grace deadline.** `relay-origin-pool.ts:278` schedules closing the old origin; the existing flow is not a guarantee of zero interruption for indefinitely active sessions. Rollout should initially restrict to control-connected hosts with no live user data sessions, with eligibility rechecked under the claim locks.

These are reachable consequences of the code, not proof of how many production hosts each affects.

### Concrete recommendation

**Keep region selection on the desktop and movement in the existing director worker. Fix the freshness contract between them.** Do not add a second RTT-based placement engine or continuous fleet-wide probe collection.

1. Extend the existing assignment request and preference row with a versioned optional region decision: conclusive/inconclusive, measurement age/expiry, and probe-policy version. Use bounded relative age to derive server expiry; repeated cached reports must not extend it. Invalidate legacy cache on adoption of the new policy. Explicit inconclusive decisions revoke migration eligibility; omission from legacy clients is not the same action. Keep legacy placement/reconnect functional, but do not let an unversioned write inherit or manufacture verified eligibility. This is client evidence, not server attestation.
2. Reuse the current resolver and sampling policy. Refresh/report expired decisions while the relay is active, using existing lifecycle scheduling with jitter and backoff. No wakeups for offline/sleeping desktops. Integrate through the assignment/broker flow so returned assignment changes are handled correctly, not discarded by a background request. Consider a debounced refresh on actual network changes; avoid a new 30-minute polling regime. Clear old cached results on policy upgrade.
3. Let the existing bidirectional worker consume only fresh, supported decisions. Reuse its target capacity, cell safety, cooldown, durable attempt, and failure-budget machinery. Add a deterministic cohort limit and initial no-active-data-session gate, rechecked under lock. Keep the current assignment stable during active work; accept delayed correction for continuously busy hosts rather than silently force-closing them.
4. Add aggregate preview/outcome counters using the same eligibility rules: eligible by direction, stale/legacy/inconclusive/busy exclusions, attempts, target registrations, completion/abort, and repeat moves. The existing candidate query has LIMIT 10, so its returned length is not a fleet candidate census. Preview must not claim attempts or consume failure budget. Start with a bounded cohort after the safety gate, expand on observed success, and retain disable control.

Ship director support first, then desktop support, then enable eligible cohorts. Existing strict assignment schema (`cloud/packages/relay-contract/src/director-messages.ts:14`) and HTTP 400 fallback (`relay-http-client.ts:201`) require explicit mixed-version/rollback tests; optional fields alone are not sufficient here. This solution requires a desktop release and director changes, but no cell image change is established as a prerequisite.

### Validation required before rollout

- Cached re-report cannot extend original measurement expiry; expired and unsupported decisions cannot trigger a move.
- Explicit inconclusive result removes eligibility; omitted legacy hint cannot accidentally certify a stale decision.
- Stable long-lived desktop refreshes after expiry without reconnect storms; sleep/resume and retries remain bounded.
- Both migration directions, capacity and cooldown exclusions, race between session admission and idle claim, and active-session preservation.
- New desktop/old director and old desktop/new director, including rollback fallback and policy-cache upgrade.
- Preview and actual claims share eligibility; cohort membership is stable and outcomes are auditable in aggregates.
- Real Postgres suites execute with a configured database (port 55440 only); skipping is not passing.

### Cost and alternatives

Current full comparison uses one warmup plus three retained rounds per origin, at up to two origins per region (`relay-region-probe.ts:109` onward): at most 16 health requests per successful full comparison. At one comparison/day for 10,000 active desktops that is 160,000 requests/day, about 1.85 requests/second averaged across regions, before retries/self-heal/startups. This is sizing arithmetic, not a billing quote or a guarantee of future cadence.

- Immediate global enable is smaller operationally, but cannot distinguish legacy/cached hints from fresh supported decisions and does not refresh stable connections.
- Forcing US or deleting assignments disrupts sticky sessions and ignores desktops for which Asia is preferable.
- IP geolocation does not measure routing/VPN performance and introduces a second conflicting decision source.
- Persisting every RTT sample centrally adds cost and complexity without fixing the freshness contract. Compact sampled diagnostics can be added if outcomes show the current probe policy is unreliable.

This recommendation corrects known mechanisms at fleet scale without claiming every high-RTT host will improve. Updated, eligible desktops converge over time; old clients and continuously busy hosts remain an explicit coverage gap. No production change was made during this investigation.

## Independent plan review

Standalone plan: `RELAY-REGION-CORRECTION-PLAN.md`. Requested reviewer: GPT-6-astra, medium reasoning. Review completed: **REVISE**. Full evidence: `RELAY-REGION-CORRECTION-REVIEW.md`. No implementation or production changes.


### Independent review outcome — supersedes earlier implementation scope

Accepted the review's P1 blockers: expiring DB splice leases cannot certify an idle live session; admission can race a locked claim; relative-age metadata alone cannot order delayed decisions or prevent stale resurrection. Required design revisions also include comparison against the actual assigned region, explicit refresh ownership, and sampled end-to-end benefit/reliability evidence. The original no-cell-rollout assumption is withdrawn: authoritative idle handoff may require cell changes and capability-gated rollout. Mobile pairing alone is harmless, but a quiet live socket remains busy; background mobile has a grace period and is not instant idle proof. See the review's revised minimal plan and the disposition at the top of `RELAY-REGION-CORRECTION-PLAN.md`.

## Follow-up: interruption experiment and simpler migration design

See [RELAY-INTERRUPTION-FINDINGS.md](RELAY-INTERRUPTION-FINDINGS.md) and [reproduction artifacts](tests/tools/relay-rehome-interruption/README.md). Forced migration recovers subscriptions in the harness, but in-flight mutations can become delivery-unknown; no real outage-duration claim is justified. The proposed replacement for the idle gate is to **let existing sessions finish on the source while new sessions use the target**, extending existing dual-origin migration. Desktop/cell preservation tests are red on current source, green with isolated timer-removal counterfactuals, and red again on restore. The store sustains a one-hour simulated dual-control migration and completes on source release.

This supersedes the idle-only handshake as the preferred direction, not the freshness/order/incumbent-threshold fixes. A negotiated mode, replay/cleanup handling, concurrency bounds, and integrated validation remain necessary. Do not deploy the diagnostic timer-removal patch; this replacement design has not yet received independent review. No production changes.

## Plan v2 review requested

Rewrote `RELAY-REGION-CORRECTION-PLAN.md` around preserving existing physical connections on their source and using the target for new connections. Retained ordered/fresh decisions and incumbent-relative thresholds. Added explicit negotiation, cleanup, failure, concurrency and validation requirements. Fresh GPT-6-astra / low review completed: **REVISE** at `33436c30d89154948013c462b74419eb748980a1`; see `RELAY-REGION-CORRECTION-REVIEW-V2.md`. No implementation or production actions.


### Plan v2 review disposition

Reviewer supports retaining existing connections over a global idle detector, but found three missing concrete contracts: same-generation source control lease renewal, retained-source rollback, and mode-aware multi-day cleanup/compatible director rollback floor. Added section 5a and a transition table to the implementation plan. These post-review corrections are not independently approved yet. Auth refresh is not source control renewal: the existing 6h ±30m control lifetime can close a retained source well before an arbitrary long user session ends. The SQLite one-hour test did not cover this. Original experiment results remain valid within their stated boundaries; no production-ready preservation claim is made.

## Retained control renewal investigation

At fetched `fb85f88d645f3e886a9df7dd2bf41d065f7e7a4c`, prototyped reusing successful cell activity renewal to extend the same retained control, avoiding a new desktop renewal timer or recurring protocol. Updated plan section 5a; [evidence](tests/tools/relay-rehome-interruption/RETAINED-CONTROL-LEASE.md). 43 registry tests and typecheck pass on prototype; 6 actual Postgres tests pass, zero skipped, on ephemeral 55440. First validated grant must precede cutover; late/failed renewals cannot extend permission. Prototype mode marker is injected, not a shipped capability. Rollback/multi-day cleanup remain separate integration requirements. Local Postgres removed; production unchanged.

## Retained renewal independent review

Fresh GPT-6-astra / low review requested for the heartbeat-based renewal revision and its evidence. Output: `RELAY-RETAINED-CONTROL-REVIEW.md`. Completed: **REVISE one narrow detail; heartbeat-reuse direction supported**. No implementation or production actions.

### Final renewal-review disposition

Added failure/recovery completion fencing to the implementation plan: obsolete authority denials after retained-generation rollback must not close the restored socket, and stale missing-activity results must not reacquire obsolete work. Current applicable failures remain enforced. Added expired-first-grant and explicit SQL lock-order/authorization-branch requirements. Reviewer did not rerun tests; prior PG17 evidence stays labeled, with PG16 prescribed for implementation validation. These are post-review plan corrections, not a tested production implementation.

## Whole-plan final review

Fresh GPT-6-astra / low review requested for the complete implementation plan, including all prior corrections. Reviewer must distinguish READY TO IMPLEMENT from rollout readiness and identify unresolved design decisions rather than merely restating required implementation tests. Report: `RELAY-REGION-CORRECTION-FINAL-REVIEW.md`. Completed; see disposition below. No implementation or production action.


### Whole-plan final review disposition — 2026-09-10

**READY TO IMPLEMENT; NOT READY TO DEPLOY.** Independent GPT-6-astra / low reviewed fetched main `a9338438c437e1ba763a03f17b9d468988bd045b` and all prior evidence. No outstanding P1/P2 plan blockers or architectural redesign required. Added and reviewer accepted explicit cold-start preservation: probe/hint before first assignment, then obtain the incumbent-bound window and perform a subsequent measurement for migration eligibility. Added corresponding initial-placement tests. Updated plan status and made section 5a explicitly normative for the earlier transition/recovery descriptions.

The review did not rerun tests. Diagnostic patches remain unshippable; negotiated protocol, durable transitions, real traffic preservation, PostgreSQL 16 concurrency on 55440, mixed-version rollback and rollout thresholds remain implementation/release gates. Rehome remains required to stay disabled during implementation; no live-state recheck or production change was performed. Full report: [final independent review](RELAY-REGION-CORRECTION-FINAL-REVIEW.md).


## Implementation checklist — 2026-09-10

Created [RELAY-REGION-CORRECTION-CHECKLIST.md](RELAY-REGION-CORRECTION-CHECKLIST.md) from the final reviewed plan. It tracks implementation phases, verification evidence and separately authorized rollout gates. Only plan review and checklist creation are complete; prototype evidence does not check off implementation. Keep it updated after meaningful implementation/validation milestones. No source implementation or production action in this step.


## Implementation started — 2026-09-10

User authorized end-to-end implementation and subagent coordination. Fast-forwarded this worktree to fetched main `027acb4efa2e6b226d40df266b86367423946d62`. Preserved the pre-existing package.json change in stash commit `e3c15dffb043c1947b584802d69eeddb43407bf0` (message: relay implementation: preserve pre-existing package.json); it removed development scripts/dependencies and cannot serve as the implementation build manifest. Preserved the pre-existing untracked relay-bench directory at `.tmp/implementation-preserved/relay-bench` because current main now tracks overlapping files. Neither preserved item was discarded or committed as feature work.

Ran the repository optional setup hook. Shared protocol review, desktop work and cell work dispatched; coordinator owns contracts/integration and verification. Local cloud dependencies being installed using pnpm 10.24.0 / Node 24.18.0. No production operations.


### First implementation verification

Shared contract suites: 35 passing, zero skipped. Director region API, async drain endpoint, worker and target-selection suites: 32 passing, zero skipped. Five new API/drain regression tests fail against baseline app.ts (18 unrelated tests excluded) and pass on the restored candidate. Existing regional rehome store suite: 50 passing after fixtures provide fresh measured evidence/capabilities; legacy deadline behavior tests explicitly seed pre-feature attempts. Cell worker reports 57 lifecycle/heartbeat tests passing and typecheck; these remain narrower than real transport acceptance.

Ephemeral PostgreSQL16 on isolated55440 is running for serial integration validation, image `postgres@sha256:f1c3376c26f2609ab9f29f71f824103fe2fcd8ee0346485cb6122a4f93df6f94`. No production access. Coordinator review has flagged remaining preview eligibility, pagination fairness and failed-target reconciliation work; implementation checklist stays unchecked until complete.


## 2026-09-10 — implementation integration

- Integrated ordered evidence, gated bidirectional claims, negotiated retention and
  same-generation rollback. Default cohort is zero even for direct store callers.
- Fixed protocol2 status ingestion, optional window failure isolation, restoration
  grant/replay while director corroboration retries, stale renewal/rebind fencing,
  Retry-After minimum and orphaned refresh-page starvation.
- PostgreSQL16 on local55440: final targeted45 tests passed, zero skipped.
- Store SQLite54 tests passed; API/target/auth suites passed; cell64 passed.
- Actual two-cell WebSocket transport test passed beyond6h31m of simulated lease
  time, with real socket traffic and ordinary target rotation. Rollback transport
  scenario and full-suite verification still running; do not infer complete acceptance.
- Added authenticated GET aggregate preview, aggregate outcome snapshots, sampled
  decision comparisons and mode/epoch fields on existing cell telemetry.
- Independent actual implementation review started. No production changes.


## 2026-09-10 — final local implementation handoff

Independent review approved both final fixes, no remaining P1/P2 blocker. Full relay
687 tests, shipping desktop188, contract35, mobile42, real WebSocket2 all pass with
zero skips. Final targeted101 tests pass after schema/traversal updates. Native phone,
actual PTY/SSH, packaged mixed versions and production benefit remain explicitly
unclaimed; see RELAY-REGION-CORRECTION-ACCEPTANCE.md. The checklist now distinguishes
implemented work from those release gates. Correction defaults off. No external writes.
