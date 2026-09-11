# Relay region correction — implementation checklist

Updated: 2026-09-11. **MERGE BLOCKED: fresh split validation reproduced the rollback confirmation failure. Earlier green runs are insufficient; release/rollout gates also remain.**

Source of truth for behavior: [final implementation plan](RELAY-REGION-CORRECTION-PLAN.md), especially section 5a. Independent verdict: [final review](https://github.com/stablyai/orca/blob/0db9fdc486366f7451289f0c0599eed9ae1d94be/docs/relay-region-correction/RELAY-REGION-CORRECTION-FINAL-REVIEW.md), against `a9338438c437e1ba763a03f17b9d468988bd045b`. Investigation history: [progress log](https://github.com/stablyai/orca/blob/0db9fdc486366f7451289f0c0599eed9ae1d94be/docs/relay-region-correction/RELAY-ROLLOUT-PROGRESS.md).

This is the execution tracker. Check a task only after its implementation and relevant verification are complete; attach the commit/PR and test evidence to that task or its phase evidence entry. Record in-progress work and blockers below. Prototype results do not complete production implementation tasks. Keep this file current after each meaningful implementation or validation milestone; record design changes in the plan and summarize them in the progress log.

## Current position

- [x] Complete independent review of the whole plan; resolve cold-start clarification.
- [x] Create this implementation checklist.
- [x] Begin implementation from current baseline `027acb4efa2e6b226d40df266b86367423946d62` in this worktree; preserve unrelated changes (details in progress log).

Active tasks: complete explicit release/evidence gaps below. The current-main rollback regression passed earlier but recurred during split validation; transport is not reliably green. Emergency-drain behavior remains covered. Remaining unchecked items denote release gaps, not claimed test coverage. See [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md). Shared API recorded in [implementation contracts](RELAY-REGION-CORRECTION-API.md).

## 1. Fresh decisions and safe initial placement — plan §§1–2

- [x] Review exact schema, protocol, atomic generation allocation and transaction/lock ordering before implementing them; reuse existing preference storage and assignment exchange.
- [x] Add opt-in server-issued measurement windows: per-host monotonic generation, fixed server expiry, incumbent assignment epoch/region, supported policy and outcome; retain only latest compact evidence.
- [x] Enforce successor invalidation, idempotent reports, inconclusive tombstones and rejection of conflicting upgrades/stale assignment basis under the claim lock. Retries must not extend expiry.
- [x] Preserve pre-placement probing and hints on first assignment; obtain the window with/after assignment and require subsequent measurements for migration eligibility.
- [x] Keep legacy placement/reconnect hints separate from verified migration eligibility; distinguish omission from explicit inconclusive decisions and exclude diagnostic overrides.
- [x] Negotiate strict request/response schemas and old-server HTTP 400 fallback without disturbing a healthy assignment.
- [x] Reuse existing sampling/spread rejection; require both regions and at least 25ms AND 20% improvement over the actual assigned region. Validate evidence bounds, policy and epoch on the director.
- [x] Clear legacy probe caches on adoption; defer movement for missing incumbent, incomplete catalog, inconclusive/tied/unsupported/stale evidence.
- [ ] Test cold start with correction disabled, hint/assignment mismatch, inconclusive probes and fallback; test delayed reports, duplicates, tombstones, clock changes, restarts, legacy writes, overrides, policy upgrades and threshold boundaries.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below.

Phase 1 progress: shared schema tests 35/35; director API/worker and target-selection tests 32/32. Five new endpoint regression oracles fail against baseline app.ts and pass after restore. Store and full compatibility verification pending.

## 2. Desktop refresh and event-driven retirement — plan §§3–4

- [x] Give the broker one deadline and one in-flight refresh/report task, canceled on close; use 24h conclusive / 1h inconclusive cadence with jitter/backoff and separate server eligibility expiry.
- [x] Handle sleep/resume without waking offline desktops; use network-change refresh only with a reliable existing lifecycle signal.
- [x] Keep probe/report failures independent of successful auth renewal; reuse the decision/window on report retries.
- [x] Serialize assignment application with drain/recovery: update same-assignment metadata, activate newer assignments through existing paths, discard stale responses.
- [x] Prevent overlapping rehomes or replacement of a retained source; allow fresh decisions to be stored for later evaluation.
- [x] Retire an old origin only after final owned connection, pending attachment and basis-bound control work ends; notify cleanup on response, rejection, timeout and close without polling.
- [x] After awaited admission, recheck local session/generation and release abandoned reservations; prevent late attachment to a retired origin.
- [x] Test unchanged-assignment continuity, auth independence, retries, sleep/resume, pending-work completion and admission/retirement races.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below.

## 3. Negotiated connection-preserving migration — plan §§4–5a

- [x] Persist optional finish-existing mode on the attempt and propagate it director → cell → desktop; bind capabilities to the current authenticated source generation/incarnation and epoch.
- [x] Defer optional moves for unsupported participants; preserve normal maintenance/emergency deadlines and auth enforcement.
- [x] Reuse the bidirectional worker, target reservations and dual-origin flow: existing source connections/pending admissions retain ownership; new connections use target.
- [x] Require a valid first short authorized source grant before drain acknowledgment/cutover; reject stale/failed/expired adoption and reconcile provisional target through rollback.
- [x] Suppress forced source deadlines only for negotiated optional mode at both desktop and cell; preserve mode through duplicate/lost receipts and zero-grace redispatch.
- [x] Complete migration after source work/control activity releases and target is live; never infer idle from expired DB splice leases or terminal activity.
- [x] Test quiet connections, two simultaneous clients, pending attachments, duplicate drains, source replacement, unsupported versions and unchanged emergency closure.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below. Timer-removal diagnostic patch is not shippable implementation.

## 4. Retained control renewal and rollback — plan §5a

- [x] Reuse successful cell activity renewal to extend the same retained control to max(existing expiry, request-start activity deadline); add no recurring desktop renewal protocol or six-hour grant per heartbeat.
- [x] Narrow the atomic DB renewal predicate to exact retained attempt/mode/source authority; prevent current-assignment authorization from bypassing an aborted attempt. Preserve assignment → attempt → migration → activity lock dependencies.
- [x] Fence every success, failure, scheduling change and awaited reacquisition continuation by captured socket/session, activity ID, authority transition and ordering; clean abandoned acquisition. Applicable denial still closes; obsolete denial after rollback does not.
- [x] Keep ordinary control rotation, JWT, silence and watchdog behavior intact. Mode flags, pending requests and reacquisition alone must not grant retention.
- [x] Implement durable idempotent rollback: newer source epoch, exact retained generation, aborted-attempt tombstone and authority validation before source admission restoration.
- [x] Reconcile cell and desktop to reuse the same source socket/splices/origin; reject late target registration/drains without replacing the preserved generation.
- [x] Reconcile target reservations and retain one open migration per host through cleanup; use ordinary failure recovery if source generation is gone, without claiming execution exited.
- [x] Test delayed denial after rollback/new authority, stale success, obsolete missing-activity recovery, expired first grant and applicable denial; assert socket/splice identity as well as expiry.
- [x] Test target registration failure, failure after activation, lost replies, concurrent rollback/register/drain and source loss.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below. Earlier mocked retention and six PostgreSQL 17 tests do not validate these future predicates/transitions.

## 5. Multi-day lifetime and resource bounds — plan §§5–5a

- [x] Make generic and regional cleanup respect durable optional mode: healthy registered sources outlive the 24h refresh ceiling and age-only zero-grace redrain; unregistered targets retain bounded recovery.
- [x] Do not spend dispatch-failure budget or force-close live work solely because an optional migration is old.
- [x] Enforce a shared, locked concurrent-migration cap including pre-existing work, alongside existing rate/cooldown/safety/capacity controls; account for both controls and target reservations.
- [x] Filter eligibility/cohort/capability before LIMIT and recheck under locks; prove fair progress across refresh/candidate pages. Use a conservative cap below the smallest relevant page capacity until traversal is verified.
- [ ] Define and record the minimum compatible director/worker revision after validation; all cleanup workers must understand durable mode/rollback states, including when claims are disabled.
- [x] Test multi-day retention, final cleanup, page fairness, concurrent cap enforcement, reservation release and restart/rollback with existing open attempts.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below.

## 6. Preview and outcome evidence — plan §6

- [x] Add read-only full aggregate preview sharing actual eligibility predicates; no capped-page census, claims or failure-budget consumption.
- [x] Record eligibility/exclusions by direction, registration/completion/abort, retained-source counts/ages, concurrent reservations, forced-close counts by mode and reconnect/error rates.
- [ ] Support compact sampled comparisons and matched before/after assigned-cell/application latency, with an unchanged comparison cohort; exclude credentials, pairing data and raw host IDs.
- [x] Verify preview side-effect freedom and eligibility agreement, counters and privacy-safe logs.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below. Region probe improvement alone is not proof of mobile end-to-end benefit.

## 7. Integrated implementation acceptance — plan §7

- [x] Run appropriate typechecks, meaningful tests, lint and formatting in their owning workspaces; record exact source revision, commands, results and skipped counts.
- [x] Run actual PostgreSQL 16 integration/concurrency suites on port **55440 only**, with a configured database and executed tests; missing-env conditional skips do not pass this gate.
- [x] Exercise real WebSocket traffic across source/target using unique stream markers and delayed mutation acknowledgment; verify continuous source traffic, no duplicate/replayed mutation and independent host-side execution/output.
- [x] Validate long retention across the old control-lease boundary plus multi-day cleanup; mocked time alone does not replace real transport integration.
- [ ] Validate mobile background/foreground reconnect and pairing preservation, multiple clients and quiet physical connections; do not infer disconnection from putting a phone down.
- [ ] Test supported/unsupported desktops/cells and old/new director compatibility, request/response fallback, worker restart and rollback at the supported floor.
- [ ] Cover SSH execution ownership and folder workspaces; use background launches, isolated profiles and no visible/focus-stealing app tests on the user's desktop.
- [x] Review the actual implementation against the plan and resolve release-blocking findings; attach final evidence to this checklist.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below. Historical experiments remain linked from the plan; no current feature acceptance is claimed.

## 8. Authorized deployment and rollout — separate release gates

Implementation work keeps new correction gated off. These boxes track future authorized operations; checking earlier phases does not authorize deployment or enablement.

- [ ] Set numerical latency/reliability regression limits, sample sizes, observation duration and stop criteria before production enable, using available traffic.
- [ ] Deploy compatible director/database support and establish the worker rollback floor, then supporting cells/desktops with the feature gated off; record revisions and deployment verification.
- [ ] Run a fresh operational safety/capability check and aggregate eligibility preview; record current state rather than relying on historical production observations.
- [ ] Obtain rollout authorization for a bounded cohort; verify disable stops new moves while safely reconciling existing attempts.
- [ ] Enable the authorized cohort and check connection preservation, cleanup, resource bounds, error rates and measured user benefit against the agreed limits.
- [ ] Expand only after acceptance evidence supports it; record rollout scope, outcomes and remaining coverage gaps for old/unsupported/inconclusive clients.

Evidence: see [acceptance evidence](RELAY-REGION-CORRECTION-ACCEPTANCE.md) and phase-specific limits below. No production changes performed for checklist creation.

## Update log

| Date | Change | Evidence |
| --- | --- | --- |
| 2026-09-10 | Created execution checklist from the independently reviewed final plan; implementation/release tasks remain unchecked. | Final review linked above. |

### Integration verification update — 2026-09-10

- **Full relay suite: 73 files, 687 tests passed, zero skipped** using PostgreSQL16
  (`ORCA_REGION_CORRECTION_POSTGRES=1`, local port55440, fresh `relay_final_test`,
  `vitest run --no-file-parallelism`). Log: `.tmp/region-relay-full-suite-final.log`.
  Earlier run's four failures exposed test fixture pollution and the schema-table
  inventory oracle; both fixed before this rerun.
- **Mobile lifecycle compatibility: 42 tests passed** across background lifecycle,
  background grace, resume director, reconnect controller and pairing recovery.
  These are deterministic transport tests, not a native mobile app demonstration.
- Node typecheck and desktop relay oxlint passed. A broad desktop path filter also picked up historical `.tmp/relay-interruption`
  prototype tests; its one failure was in that prototype, not current source.
  Shipping suite rerun excluding `.tmp/**`:21 files188 tests passed. Real transport:2 passed.
- Independent implementation review: **REVISE** with two concrete findings. Claim
  candidate starvation fixed with separate durable visit order and a >10-host
  opposite-direction regression. Target recovery versus retained-source rollback
  race fixed and tested. Independent follow-up: APPROVE both fixes, no remaining P1/P2 blocker;11 retention tests independently passed. See implementation review document.
- Production gates remain untouched. No deployment, enable, merge or push performed.

### Final local implementation disposition

- [x] Complete and independently review implementation fixes; zero remaining P1/P2 findings.
- [x] Record full test commands/results and source digest in acceptance evidence.
- [x] Register real-WebSocket reliability gate as experimental/partial, not deployment proof.
- [x] Preserve unrelated user edits and record their recovery locations.

Broad testing rows remain unchecked where they also require packaged mixed-version,
native-phone, actual PTY/SSH, or all-platform coverage. The real transport harness proves
host-side mutation delivery/continuity but does not execute a real terminal process.
Sampling and epoch-tagged control/setup logs are implemented; actual application
latency benefit and numerical rollout limits require release observation. The full
changed-code-quality gate is blocked only by two pre-existing braces violations in
preserved `find-cell.mjs`; implementation-specific lint and both typechecks pass.

No production enable, deployment, merge or push performed. Code remains reviewable as
local worktree changes. Authorization for implementation does not imply rollout.

### Release-readiness follow-up — 2026-09-10

- [x] Test exact old strict schemas against current assignment fallback; preserve a
  healthy assignment when optional correction metadata is unsupported/malformed.
- [x] Test durable decisions across database reopen, server expiry and policy rollback.
- [x] Add independent child-process execution and append-once mutation evidence to
  real-WebSocket journeys; verify pending restoration beyond105s and ordinary rebind.
- [x] Build cloud and Electron release output; verify rebuilt app renders with hidden,
  unfocused windows in an isolated profile.
- [x] Add audited cohort deployment input and preserve its serving value through
  Terraform; fix independent release-review findings,55 tests passed.
- [x] Refresh against current main74cc9b5039 and preserve both reliability entries.
- [ ] Complete physical phone/signed upgrade/live SSH/platform validation before enable.
  - 2026-09-10: Android device connected; installed `com.stably.orca.mobile` reports version `0.0.44` (code 13). Background/foreground launch cycle completed via ADB with no relay/reconnect log lines emitted; this validates lifecycle launch only, not a paired relay session.

Full relay suite now691 passed0skips,121 reliability gates validate. See acceptance
follow-up for exact limitations and control-socket wording correction. No Android
device connected during this session. Numerical rollout criteria are proposed in
[rollout plan](RELAY-REGION-CORRECTION-ROLLOUT.md), not accepted production measurements.

### Current-main validation regression — resolved

Current baseline: `74cc9b50390b481009b34823a35eee01a5b90e40`. Latest combined desktop/transport run: **202 passed, 1 failed** (`.tmp/region-on-main-validation.log`). The rollback journey observed source generation 1 replaced by generation 2 with one existing splice. Earlier green transport results do not clear this failure. The corrected focused real-WebSocket rerun passed 2/2; focused registry/origin tests passed 11/11 and Docker SSH transport recovery passed 6/6. No production operations authorized or performed.

### Rollback race fix — 2026-09-11

Independent review confirmed the generation-2 replacement was caused by an already armed `drainRetry` callback firing after rollback restoration removed the retained source. `restoreOrigin()` now calls `drainRetry.cancel()` rather than resetting only its attempt counter. The attempted non-active-origin guard was discarded because it changed emergency-drain semantics. Scoped lint/format passed; rerun the full current-main transport suite before release acceptance.

### Final race rerun — 2026-09-11

The focused retention tests passed (12 tests), but the real-WebSocket rollback journey still failed: `regionalRestoration` remained set after corroboration (`.tmp/final-race-tests.log`), with 12 passed and 1 failed. Two races contributed: the relay registry refused a matching resume while the restored source had entered `drain-only`, allocating generation 2 despite an active splice; and successful corroboration cancelled the ordinary drain retry but left the separate restoration retry armed. The registry now preserves restored generations, and `restoreOrigin()` cancels both schedules. Validation: `ORCA_BACKGROUND_LAUNCH=1 pnpm test tests/e2e/relay-region-correction.unit.test.ts` — **2/2 passed** (`.tmp/rollback-review-transport2.log`); focused registry/origin tests — **11/11 passed**. Production rollout remains gated on the remaining release gaps listed below.

### Pull request and CI — 2026-09-11

- [x] Create coordinated cloud/desktop draft PR and run CI.
  - PR [#20031](https://github.com/stablyai/orca/pull/20031); corrected commit CI passed Secret scan, build, Terraform, test, and test-vs-non-test LoC. No review comments yet.

## Review scope — 2026-09-11

Cloud and desktop are separate dependent branches: `main` → `relay-region-cloud` →
`relay-connection-speed`. Historical investigation material is archived outside
the shipping diff. See acceptance evidence for the simplification and split checks.
Release gates above remain open; cloud can precede desktop release with correction
disabled and legacy clients excluded by capability negotiation.
