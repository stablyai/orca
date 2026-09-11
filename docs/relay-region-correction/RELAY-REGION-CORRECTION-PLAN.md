# Relay automatic region correction — implementation plan v2

Status: **READY TO IMPLEMENT; NOT READY TO DEPLOY**, following the final independent GPT-6-astra / low review against fetched main `a9338438c437e1ba763a03f17b9d468988bd045b`. No outstanding P1/P2 plan blockers; cold-start placement clarification incorporated and accepted. See [final review](RELAY-REGION-CORRECTION-FINAL-REVIEW.md). Section 5a is normative for first-grant adoption, retained-source rollback, renewal and cleanup; earlier generic transition wording must not override it. Earlier REVISE verdicts remain historical evidence. This replaces the idle-only proposal. This plan-review request authorizes no implementation, merge, deployment, or production enable.

Implementation tracking: [live checklist](RELAY-REGION-CORRECTION-CHECKLIST.md). Completed work and validation evidence are recorded there; this document defines the behavior.

## Outcome and precise terms

An updated desktop obtains a reliable region preference. If its assigned region is materially worse, the existing director worker makes the better region the destination for new connections. Existing physical relay data connections continue through the old cell until they close or fail naturally. The desktop then releases the old origin and the durable migration completes.

“Existing connection” means a physical client-to-desktop relay data connection, represented by a cell splice and desktop connection ownership. It can carry multiple commands and subscriptions; it is not a terminal process, agent run, saved pairing, or recent typing. Tracked pending attachments and basis-bound control requests also protect source retirement. Quiet live connections are retained. No fixed maximum connection duration has been established or proposed for optional optimization.

For mobile: active use remains on the old cell; after the app actually suspends/closes that connection, the next successful connection resolves to the target. Current mobile schedules background suspension after 30 seconds, and checks an overdue deadline on foreground if the timer did not run. Putting the phone down while the app remains foreground is not a disconnect. No re-pairing is required solely for relocation.

Promise: optional region optimization does not deliberately terminate pre-existing connections merely because its grace timer expired. This is not a guarantee against network failure, process exit, revoked/expired auth, or emergency maintenance. New connection attempts during target startup may need normal recovery; do not promise zero delay on those attempts.

## Evidence and reuse

Source experiments used `origin/main` at `721a2692893ab29f8daee3149965bf5e9adf99a0`. Review must fetch current main and record its SHA, distinguishing changed source from these dated results.

- Bidirectional worker already exists in #19241 and predates deployed #19915. Do not implement a second placement/migration engine.
- Desktop `relay-origin-pool.ts` already opens a target, retains source connection ownership, and closes the source after final release. Auth refresh already visits every origin.
- Cell `host-session-registry.ts` has drain-only state, live/pending connection maps, and existing control renewal. Director store already retains migration state until source activity releases.
- Two unconditional deadline sites force interruption: desktop origin-pool and cell regional host drain. Removing those scheduling sites in a diagnostic snapshot made both preservation tests pass; restoring source made the identical tests fail again.
- A SQLite store test sustained a registered migration for a simulated hour with both controls renewed, then completed on source release.
- Mobile harness restored credentials/assignment/subscriptions after simulated drain. Sent mutations can become delivery-unknown and are not blindly replayed. The 251ms fake-clock recovery result is not measured real-world downtime.

Full evidence: [interruption findings](RELAY-INTERRUPTION-FINDINGS.md), [harness and patches](tests/tools/relay-rehome-interruption/README.md). The counterfactual patch is NOT production code: it has no negotiation, incorrectly changes normal deadline semantics, and does not validate failure/replay paths.

## 1. Ordered, expiring region decisions

Reuse desktop sampling and the existing assignment exchange. Separate legacy placement hints from eligibility to move an existing assignment.

Preserve cold-start placement: run the existing pre-placement probe and send its placement hint with the first assignment request. Do not create a default-region assignment merely to obtain a measurement window. Obtain the epoch-bound window with or after that first assignment; only a subsequent post-window measurement can certify migration eligibility. Test first placement with and without conclusive probes, plus old-server fallback, so the new migration protocol does not regress initial placement.

Proposed concrete protocol: an opt-in server-issued measurement window. A supporting desktop requests a window; director returns a per-host monotonic generation, fixed server expiry, and incumbent assignment epoch/region. Issuing a successor invalidates the predecessor for migration. The desktop probes after receiving the window, then reports a conclusive or inconclusive decision for that generation. Repeated delivery cannot extend expiry. An inconclusive outcome is retained as a tombstone; delayed older conclusive reports cannot resurrect eligibility. A restart that cannot reuse a valid cached decision obtains a successor window. Server time is authoritative for expiry.

Persist window generation/expiry, incumbent basis, supported probe-policy version, and outcome in the existing preference state. Keep the latest supported evidence only; no history of every probe. Duplicate same-generation decisions are idempotent; conflicting same-generation outcomes must not upgrade inconclusive to conclusive. Serialize window issuance/reporting per broker and reject stale assignment basis under claim lock. The exact schema and transaction ordering must be reviewed before implementation.

Legacy enum-only requests retain placement/reconnect behavior but cannot inherit or overwrite verified migration eligibility. Explicit new inconclusive decisions and missing legacy fields are different operations. Diagnostic region overrides are not measured proof. New request and response fields require explicit opt-in because both schemas are strict. Deploy server support before clients; implement old-server 400 fallback for both request shape and response negotiation without changing a healthy assignment.

## 2. Compare with the actual assigned region

Keep the current warm-up, sample count, spread rejection, and requirement that both regions be measurable. Initial placement may pick a best measured region. Moving an existing assignment additionally requires target latency at least **25ms lower AND 20% lower** than the measured incumbent region. These are the existing hysteresis thresholds applied to the correct basis, not a production-validated optimum.

Report compact comparison evidence (incumbent/target region timing, policy and reason), tied to the window and assignment epoch. Director validates bounds, eligibility and margin. A missing incumbent, incomplete catalog, rejected measurement, nearly tied regions, unsupported policy or stale assignment basis means no move. Clear legacy probe caches on upgrade without treating an unopposed or 1ms winner as migration evidence.

This optimizes the desktop-to-region path. Sample actual assigned-cell and mobile application behavior during rollout before claiming end-to-end user benefit.

## 3. Refresh ownership and cadence

The broker owns one decision deadline and one in-flight refresh/report task. Cancel them on broker close. Reuse the successful 24-hour cache interval and one-hour inconclusive retry interval, with jitter/backoff; eligibility expiry is distinct from retry scheduling. Do not wake offline/sleeping desktops for probes. On resume, check deadlines before using expired eligibility. Debounce network-change refresh only where the existing lifecycle provides a reliable signal.

Probe/report failure must not fail successful auth renewal or intentionally reconnect healthy controls. Serialize assignment response application with drain/recovery: same cell/epoch updates metadata; a newer assignment follows the existing target activation flow; stale responses are discarded. Report retries reuse the same decision/window rather than re-probing or extending expiry. During an open migration, do not claim another move or replace the retained source; refresh decisions may be stored for later reevaluation only.

## 4. Extend graceful migration to finish existing connections

Introduce an explicit opt-in drain mode for optional regional optimization. Persist it on the attempt and propagate it through the director-to-cell host-drain command and cell-to-desktop drain message. The source must learn mode from durable protocol state, not infer it from grace=0, a hostname or a retry count. Maintenance/emergency drains keep their current hard deadlines.

Eligibility requires supporting desktop and cell capabilities, fresh decision and matching source epoch/incarnation. New protocol/capability values and strict-parser fallbacks need cross-version tests. An unsupported participant defers optional correction rather than falling back to forced close. The reviewer should challenge how host capability remains bound to the currently active source generation, not merely a stale version-bearing report.

Nominal transition:

1. Existing claim reserves target capacity and commits target assignment plus migration/attempt state.
2. Source receives the mode-bearing drain and establishes the first valid authorized grant specified in section 5a before acknowledgment/cutover; desktop resolves/registers the target through existing code.
3. Target becomes the desktop's active origin. Existing source connections retain their source ownership; new connections resolve the current assignment. Already-admitted pending source connections may finish attaching and remain there.
4. Optional regional mode installs no forced old-origin/session close deadline. Existing event callbacks retire the source after its last owned connection and pending control operation end. Retain normal auth enforcement and operational emergency-close behavior.
5. Source control release/orphan cleanup removes its remaining activity. Existing completion logic finalizes the migration after source activity is gone and target is live.

Do not use DB splice lease absence to infer idle: those leases can expire with a live socket. This design instead allows source work to exist. Do not build the proposed pre-move globally atomic idle gate.

Required integration checks: pending control-RPC completion must trigger retirement when it was the final outstanding item; attach timeout/rejection and late async admission must not leak an origin or attach after retirement. Preserve existing source/target identity and request ownership. Cover two simultaneous mobile clients and a quiet connection; terminal counts and workspace type do not decide transport lifetime.

## 5. Failure, replay and bounded resource use

This section is a required implementation contract, not evidence that the current implementation already satisfies it.

| Condition | Required behavior |
| --- | --- |
| Target registration fails | Retain still-live source work; retry or reconcile using existing migration recovery. Restore source new-admission authority only through section 5a's retained-generation rollback; do not discard a migration that still owns connections. |
| Lost receipt / duplicate drain / zero-grace re-drain | Read durable mode and preserve existing work. Replay must never turn optional mode into forced closure. |
| Desktop restart / source generation replacement | Old process connections may already be gone; reconcile exact generations before retaining or clearing state. Unsupported replacement must not silently hard-drain existing work. |
| Source network/cell failure | Use existing failure recovery; connectivity loss is not proof remote execution exited. This is outside the no-deliberate-interruption promise. |
| Target fails after becoming active | Keep source connections that remain live; reconcile assignment/new connections through existing recovery without starting a third overlapping rehome. |
| Auth expiry/revocation or emergency cell drain | Preserve existing enforcement; optimization does not exempt sessions from security/maintenance lifecycle. |
| Last source data connection closes while control RPC pending | Wait for bounded RPC completion/timeout, then run cleanup without a polling loop. |
| Source remains busy for hours | Keep the migration open while healthy. Long duration alone does not force-close users or spend dispatch-failure budget. |

Bound **concurrent open migrations** in addition to starts/minute. Count pre-existing attempts; one migration per host remains enforced. Retain both controls' auth/lease renewals and account for source use plus target reservations. Data is not duplicated; extra controls/reservations still consume capacity.

Ensure fair progress in the existing 100-row lease-refresh and 10-row candidate/sweep pages; waiting old migrations must not starve registration, renewal or cleanup for newer ones. Initially enforce a conservative concurrency bound below the smallest relevant page capacity, counting existing open work, until fair traversal is verified. Filters for cohort/policy/capability belong before LIMIT and are rechecked under locks.

No user-visible maximum drain duration is claimed. If operations later require one for optimization, forcing closure would change the product promise and needs an explicit decision; a larger timer is not equivalent to finish-existing behavior.

## 5a. Review corrections: retained-source authority and lifetime

The independent review found three required contracts. This section supersedes any suggestion above that unchanged auth renewal or generic rollback suffices. Current source-control lifetime is six hours with thirty-minute jitter; auth-refresh does not extend it, and ordinary rotation only renews the active target. Current durable rehome refresh also has a 24-hour age ceiling. The one-hour SQLite experiment proved neither of those paths safe for indefinite live retention.

### Reuse the cell's existing activity renewal (supersedes the extra wire exchange)

Follow-up investigation found a smaller mechanism: a successfully validated `renewControlActivity` result can extend the same retained control's in-memory lease to `max(existingExpiry, requestedActivityExpiry)`. The cell already runs this renewal; no new desktop renewal timer, old-source rebind or recurring WebSocket exchange is needed. See [prototype evidence](tests/tools/relay-rehome-interruption/RETAINED-CONTROL-LEASE.md).

Before acknowledging the optional drain and telling desktop to cut over, establish the first short authorized renewal for the exact mode/attempt/source generation/incarnation. Subsequent grants reuse normal heartbeat renewal. Failure or stale state during adoption does not authorize retaining the source; reconcile the provisional target through the rollback contract below. A mode flag, pending database request or activity reacquisition alone is not a grant.

Narrow the existing atomic database renewal predicate with the retained attempt/mode/source basis, using immutable fields and preserving existing lock order; avoid a new precheck/query that can race mutation. The success callback must still match captured attempt, live session/socket/generation and mode; retirement/rollback/replacement/emergency drain invalidates it. Use the deadline sent at request start (currently 105s ahead), not response time, and do not add six hours on every heartbeat. Keep normal JWT/silence/watchdog enforcement and ordinary control rotation unchanged. Normal mode retains its existing lease; only extra retention needs these short successful grants.

Prototype evidence: 43 cell-registry tests and package typecheck pass, including >12h simulated retention without extra recurring renewal calls; 6 real Postgres renewal tests execute with zero skips on local 55440. Baseline/revert fails the three extension oracles. The prototype injects the future mode marker and is NOT production-ready: initial adoption ordering, durable mode predicate, wire negotiation and rollback remain integration work. This revision addresses source renewal only, not the whole retention feature.

### Final renewal-review correction: fence failures as well as success

Fresh GPT-6-astra / low review: [retained-control review](RELAY-RETAINED-CONTROL-REVIEW.md), **REVISE one completion-fencing detail; heartbeat reuse supported**. The following correction is incorporated after review, not independently approved or implemented.

Every renewal completion and awaited recovery continuation must validate its captured socket/session, activity ID, current authority/mode transition and applicable ordering before altering scheduling, extending expiry, closing a socket, or reacquiring activity. In particular, a denial from an aborted retained attempt arriving after same-generation rollback must not close the restored source. A current applicable denial must still enforce closure. An obsolete missing-activity result must not initiate recovery; after awaited recovery, recheck authority and clean up abandoned acquisition as required. Do not use a blanket success-only fence or suppress all failures.

Add controlled-promise tests for late denial after rollback, after a newer valid authority transition, obsolete missing-activity recovery, and applicable denial. Verify both preserved socket/splice identity and correct rejection, not just expiry values. First-grant adoption must also reject a success whose requested expiry is already past.

In retained-mode SQL, the ordinary current-assignment authorization alternative must not bypass an aborted attempt check after rollback. If locking attempt rows, preserve assignment -> attempt -> migration -> activity dependency order used by existing rehome operations, rather than appending a late attempt lock. Use the prescribed PostgreSQL 16 environment for implementation concurrency validation on 55440; the earlier six-test PostgreSQL 17 run remains accurately labeled as narrower evidence.

### Retained-generation rollback

Generic source reassignment alone is insufficient: the source cell otherwise remains drain-only, and a fresh generation closes old splices. Add a durable, idempotent rollback transition for the exact optional attempt. In one authoritative store transaction, assign a newer source epoch and record that attempt's rollback outcome and retained source generation. Reconcile the source cell to that state: clear only that attempt's optional drain, preserve its socket/splices, update assignment metadata, and restore new admission only after validating current authority. Keep an aborted-attempt tombstone so a late drain cannot reverse rollback.

Desktop recovery must find/reuse the retained source origin and update its assignment metadata without replacing its control generation or transports. This needs an explicit supported transition, not the current rebind-failed -> fresh-generation fallback. Late target registration cannot override the newer source epoch. Release target reservations when reconciled; keep one open migration per host until cleanup completes. If the source process/generation is gone, use ordinary failure recovery and report that preservation is unavailable; do not infer remote execution exited.

### Transition table

| State/event | Authority and action | Existing source work |
| --- | --- | --- |
| Claim optional move | Durable attempt binds mode, source generation/incarnation, target, epoch and supported participants | Retained |
| Target registering | Source receives optional drain; existing target retry/reconciliation proceeds | Retained; do not convert age into forced closure |
| Target registered | Director target assignment is authoritative; desktop activates target | Existing source connections keep their origin |
| Retained source needs renewal | Existing cell activity renewal + exact optional migration authorize a short same-generation lease extension | Retained, source remains drain-only |
| Target failure / rollback | New durable source epoch plus rollback tombstone; source cell and desktop reuse exact retained generation | Retained if that generation still exists |
| Final source work ends | Connection and pending-work callbacks retire source; cancel renewals; release activity and complete | No source work left to preserve |
| Delayed drain/renew/register | Compare durable attempt outcome and epochs; ignore/reject obsolete transition | Must not resurrect draining or replace generation |
| Source failed / emergency drain | Existing authenticated operational/failure semantics apply | Preservation not promised under those failures |

### Mode-specific durable lifetime and compatibility floor

For healthy registered optional retained-source attempts, remove the current 24-hour age-only lease-refresh ceiling and exclude them from the age-only zero-grace re-drain lane. Keep bounded target-registration failure/reconciliation; do not extend an unreachable unregistered target forever. Duration alone is not dispatch failure, and active source data must not be dropped to reclaim an optimization slot. Current generic and regional cleanup paths must both understand the optional mode.

Before enabling optional retention, deploy a director/worker compatibility floor that understands all durable mode and rollback states even when new claims are disabled. Operational rollback must not go below that floor while such attempts exist. A disabled enable flag does not stop older cleanup/redrain code from misinterpreting new rows. Prove safe restart/rollback with existing open attempts and multi-day retention. The minimum revision will be recorded only after the compatible implementation is merged and validated.

Additional accepted obligations: notify retirement on every final pending-control transition (response, rejection, timeout, close); perform a final local session/generation check after awaited admission work and release abandoned reservations; bind negotiated support to current authenticated source generation rather than a stale measurement report; enforce the concurrent-migration cap in locked shared state, including pre-existing work. None of these requires rebuilding a global idle detector.

## 6. Rollout and observability

Keep rehome disabled while implementing/testing. Deploy compatible director/database support, then supporting cells and desktops with feature gated off. Verify readiness and actual capabilities before enabling an authorized bounded cohort. Do not dispatch workflows as part of this review.

Reuse current rate, cooldown, safety, capacity, durable attempts, and failure-budget controls. Preview must be read-only and share eligibility predicates, report full aggregate counts rather than a capped candidate page, and never claim attempts or consume budget.

Track eligibility/exclusions by direction, target registration, migration completion/abort, number/age of retained sources, concurrent reservations, deliberate forced-close count by drain mode, and reconnect/error rates. Retain compact sampled comparisons and matched before/after assigned-cell/application latency where available; a registered target alone is not evidence of user benefit. Use an unchanged cohort to detect unrelated network variation. Never log credentials, pairing data, or raw host IDs.

Acceptance: supported eligible hosts move new connections to their chosen target; old data connections survive optional-drain deadlines and retire on actual release; no forced source close solely due to optimization age; resources clean up; failures remain recoverable; sampled latency/reliability shows benefit without material regression. Specify sample sizes and numerical regression limits before production enable, using available traffic rather than inventing measured thresholds here.

## 7. Required validation and implementation order

1. Land freshness/ordering and incumbent-relative eligibility support under disabled control, with strict request/response compatibility tests. Cases: first-ever placement with correction disabled, placement-hint/actual-assignment mismatch, cold-start inconclusive probes and old-server fallback; delayed old reports, duplicates, inconclusive tombstones, clock changes, restarts, legacy writes, overrides, policy upgrades, stale epochs and cache clearing.
2. Implement broker refresh and event-driven origin retirement, test no auth coupling, no reconnect on unchanged assignment, pending-operation completion and sleep/resume.
3. Implement negotiated optional drain mode end-to-end in existing worker/cell/desktop paths, including normal emergency deadlines and replay. Extend the diagnostic oracles into real feature tests; do not merge the timer-removal experiment.
4. Validate real WebSocket traffic across source/target while sending unique stream markers and a mutation with delayed acknowledgment; check no duplicate/replayed mutation and independent host-side execution/output. Then validate mobile background/foreground reconnection and pairing preservation. Mock tests are not an end-to-end substitute.
5. Run actual Postgres integration/concurrency tests on **55440 only**. Require configured database, executed test counts and no conditional skip. Cover registration failure, target failure, concurrent admissions, cleanup, pagination and capacity accounting with long-lived sources.
6. Validate supported/unsupported desktop and cell combinations and old/new director rollback. SSH-hosted execution and folder workspaces remain governed by transport/owning host, not local process assumptions. No visible app tests on the user's desktop; background launch and isolated profiles are required.
7. Run a fresh operational safety gate and capability check only when a reviewed rollout is authorized. Enable a bounded cohort, observe retained-source/resource/benefit evidence, then expand. Disable stops new optional moves while safely reconciling existing ones.

## Review request

Review this revised design against fetched main and the evidence. Challenge especially: whether keeping both origins really avoids the earlier idle race; source retirement while async attaches/control requests are pending; re-drain/cleanup converting the mode back to forced close; source/target generation and capability negotiation; indefinite-source cost and page starvation; failure rollback; ordered measurement windows; and whether this is the smallest defensible approach.

Return severity-ranked findings with exact immutable-ref file:line evidence and concrete scenarios. Distinguish proven current behavior, counterfactual experiments, and unproven implementation obligations. End APPROVE / REVISE / REJECT with the smallest corrections. Save the independent final review as `RELAY-REGION-CORRECTION-FINAL-REVIEW.md`. No implementation or production actions.

Historical review: [v1 medium review](RELAY-REGION-CORRECTION-REVIEW.md). Original draft archived at [plan before second review](tests/tools/relay-rehome-interruption/PLAN-BEFORE-SECOND-REVIEW.md).


### Implementation correction: restoration confirmation can retry

A rollback response can reach the cell while desktop director corroboration fails.
The cell therefore retains an exact pending-restoration authority (aborted attempt,
newer source epoch, original generation/incarnation/activity) until ordinary
same-generation rebind confirms restoration. Each successful existing heartbeat
renews only its short request-start deadline and replays `region-restored`.
Retained and restored authority are mutually exclusive; the old retained authority
remains rejected after rollback. Rebind, replacement, emergency drain, and applicable
denial fence outstanding callbacks. No extra timer or six-hour heartbeat grant is
introduced. This avoids losing long-lived source connections merely because the
first director confirmation failed.
