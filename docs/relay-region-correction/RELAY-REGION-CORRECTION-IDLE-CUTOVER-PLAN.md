# Relay region correction — idle cutover plan

Status: **REVISION 2 — DESIGN APPROVED; implementation and verification pending.**

Independent GPT-6-astra low review found no remaining design blocker. Approval is
conditional on the implementation gates below: pre-await ownership accounting,
shared assignment-row serialization, locked ambiguous-outcome reconciliation,
operation identity deduplication and late-callback fencing must be proven in tests.
Four independent idle-scope audits have been counted conservatively (scope, plan v1,
simplification, revision 2). If another plan revision fails review and a sixth cycle
would be needed, stop for user re-evaluation. Approval does not mean the current
live-retention PRs implement this design or are ready to merge.

## Requirement and deliberate tradeoffs

Automatically improve the host's relay region when no relay clients are using it.
A phone and iPad both disconnecting can create an opportunity. Continuous clients
can postpone optimization indefinitely. Returning during a move may incur ordinary
reconnect delay; zero-delay reconnect is NOT a requirement. Do not deliberately
close an established client connection to optimize latency. Direct LAN sessions
and running terminal processes do not themselves count as relay clients.

The mobile 30-second background grace is not a reliable scheduling event: the OS
can delay it. Use actual source-cell connection state. Desktop control remains
open without phones; do not wait for it to disappear naturally.

Keep fresh desktop measurements, incumbent-relative 25ms AND 20% improvement,
cohort/enable controls, capacity checks and cooldown. Probe improvement is not
proof of improved application latency. Cloud selects authoritative assignments;
mobile reconnect reads an assignment, it does not choose a faster region.

## Simplicity constraints

Reuse the regional worker, assignment transactions, reservations, request identity,
cell admission registry and normal desktop reconnect. No live-source retention,
splice transfer, recurring retained-control lease, new mobile protocol, global idle
poller, or desktop background-disconnect timer. Existing data sockets are never
copied or transferred (the former design did not transfer them either).

Try an idle opportunity, immediately defer if busy; do not keep a gate waiting for
users to leave. The gate exists only for a short attempted cutover. A retryable
arrival may lose this race and reconnect normally. Do not count that as evidence
of lost execution or replay a previously sent mutation.

Source cells already share the assignment database. Use one source-owned local
barrier around a constrained assignment transaction; do NOT introduce a distributed
prepare/commit protocol, a durable preparation table, or a second admission service.
The director selects candidates; the source's transaction rechecks director policy.

## What is idle?

The source owns one per-host/generation admission barrier covering every accept,
attach and control replacement path. Inventory these paths before changing them.
The quiescence predicate must require:

- `activeConnIds.size === 0` (includes attaches while persistence awaits).
- `activeSplices.size === 0` and `pendingConns.size === 0`.
- Zero accepts in flight before insertion in those maps. Track ownership before
  the first asynchronous operation that can admit this host; every exit releases it.
- Zero in-flight control operations that install credentials, mutate connection
  basis or create admissions. Track actual server handlers; do not invent an
  approximate count from RPC traffic or old database leases.

An authenticated open desktop control socket, its ping/pong and activity renewal
are NOT client work and NOT a reason to defer. They can remain until cutover closes
the empty session. A desktop request arriving after the barrier gets a normal
retryable transport failure; finish previously accepted state mutations before
claiming idle. Reconnection must preserve pairing and not blindly replay mutations.

Missing/expired database activity leases are never proof of idle. Outstanding
reservation cleanup remains owned and must be completed or safely fenced, but
waiting for every lease to expire would wrongly wait on the healthy control lease.

## Source-owned try-cutover

1. The director selects candidates read-only, using existing eligibility and pacing.
   It sends an authenticated idle-cutover request with stable operation ID, expected
   source assignment epoch/incarnation/generation and candidate target. Selection
   does not reserve capacity or change assignment. Repeat delivery uses the same ID.
2. Source validates the request and current session. In one synchronous segment,
   check all counters and install a per-host barrier. If busy, return `busy` without
   closing sockets or holding a barrier. Busy is a deferral, not a dispatch failure.
   The next worker pass must progress past busy candidates rather than starve others.
3. While barred, reject new clients and any new source control activation/rebind.
   Late asynchronous continuations must recheck barrier/session after awaits and
   release abandoned reservations. Install this fence before the first await of
   the cutover. No barrier timer may reopen admissions on its own.
4. Source calls a constrained version of the existing assignment transaction. Reuse
   its lock order, global rate/concurrency controls, cooldown, capacity reservation,
   freshness and safety checks. Recheck exact source epoch/incarnation/generation,
   target and operation identity. Reserve target, update assignment/epoch and record
   the existing durable migration/attempt atomically. Do not call today's unrestricted
   `claimRegionalRehome` and let it choose a different host. No network calls inside
   DB locks. Zero sockets is established locally, not inferred from activity leases.
5. If committed, retire the still-empty source session/control via the existing
   resolve-director closure path and release its activity. Desktop uses normal
   reconnect and registers on target. Reply with the durable operation outcome.
6. If definitively not committed and source authority remains unchanged, remove the
   barrier and continue on the original control. No target reservation survives a
   rolled-back transaction. If authority changed, retire the obsolete source instead.
   A timeout or transport error is NOT definitive rollback.

## Ambiguous transactions, restarts and failures

The request operation ID is known BEFORE the transaction and recorded as the
existing attempt ID on commit. Duplicate calls return its outcome and never start
another migration. A concurrent retry, cancellation or definitive-abort check must
serialize under the same host lock as commit; an unlocked absent-row lookup is
insufficient because the original transaction could still commit later.

Keep a barrier until the database transaction is known terminal and a locked
reconciliation establishes the outcome. If the driver result is ambiguous, retry
status through a per-attempt backoff callback, using the same identity. If durable
access is unavailable, remain fenced; bounded availability cannot be promised
while the assignment's authority is unknown. No timeout-only reopen. Use the
existing DB transaction timeout and request timeout, not a new renewable gate lease.

A lost director HTTP reply does not interrupt source-owned completion: source
finishes its transaction, reads durable outcome and closes/reopens locally. A
retry from any director sees the same operation. Director crashes do not strand
preparations because no separate preparation exists.

A source restart/replacement control is fenced by existing authoritative registration
and activity validation. It must serialize against the cutover transaction under
host locks, validate the current assignment and reject old source ownership if the
commit won. If replacement won, the old transaction must fail its generation/
incarnation recheck. This requires tracing current registration persistence and
proving the shared serialization point, not relying solely on the in-memory fence.
Late callbacks from a closed session cannot reopen admissions for its replacement.
Emergency drain invalidates local authority and participates in this serialization;
a cutover already committed follows its outcome, never reopens the emergency source.

After commit, target registration failure uses ordinary bounded migration recovery.
The old empty control must be released even if outcome delivery failed; otherwise
current rollback refuses while source activity remains (`assignment-store.ts:6923`).
Source process death is handled by normal activity expiry and cell incarnation
fencing. No live clients were discarded, but a returning client may wait for recovery.
Once clients attach at target, preserve them under ordinary assignment rules:
initial source idleness never authorizes closing future target clients.

## Compatibility and authority

Mobile already re-resolves on `WRONG_CELL` (4409) through
`dialRelayThroughDirectorFallback`; use that existing close code for arrivals at a
gated source. Before commit, resolution can still return the old address: existing
backoff must prevent tight retry loops. After commit it returns the target. Pin
old parser/client fixtures and test the actual codes; do not assume every error is
retryable. Do not introduce a new mobile close code or protocol message.

Empty host control closure uses the existing `DRAINING` / resolve-director path;
verify its reconnect behavior against the baseline desktop implementation.
Negotiate a distinct idle-cutover capability for participating cells and updated
desktops; do not reuse finish-existing capability to imply this new behavior.
Unsupported participants skip optional correction. Preserve old-server HTTP-400
fallback for measurement fields. Emergency drain/auth enforcement can invalidate
any in-flight cutover; it must fence late commit and preserve existing hard deadlines.
Disabling correction stops new attempts; existing ones still reconcile.

## Review and implementation gates

Review must verify the shared-store serialization and identify every admission and
control mutation path before approving implementation. Minimum tests (red before
green for new guarantees):

1. Phone remains while iPad disconnects: no move. Both disconnect: move possible.
   A quiet established socket or expired DB splice lease still prevents a move.
2. Accept before/after barrier, accept awaiting activity persistence, attach awaiting
   basis persistence, and credential mutation crossing the barrier. No late attach,
   leaked reservation or interrupted established client.
3. Busy attempt leaves source admissions usable; repeated busy hosts do not starve
   idle candidates or consume dispatch-failure budget.
4. Commit/replacement race; lost database/HTTP replies; timeout during transaction;
   duplicate workers; director crash; source restart; replacement control; stale
   epoch/incarnation; database outage and recovery. No timeout-only reopening.
5. Target failure before registration and after new client attachment; source-control
   release; ordinary recovery completes without retained-source restoration.
6. Current/old mobile reconnect before and after commit, same-address retry pacing,
   pairing preservation and no mutation replay. Old/new desktop/cloud combinations.
7. Emergency drain/auth denial during the cutover; no altered hard-drain behavior.
8. Real TCP WebSockets for two clients, admission race and failed cutover, independent
   execution-process identity and append-once mutation evidence. Docker SSH and
   folder workspace continuity. Tests use `ORCA_BACKGROUND_LAUNCH=1`.

Keep tests proportional: deterministic component races first, then real transport,
relevant cloud/desktop suites, types/lint and PR CI. PostgreSQL only on 55440 when
validating authoritative transactions. Do not replace a failing oracle with a weaker
assertion or accumulate tests mirroring implementation.

After clean review, replace superseded feature code/tests/docs on the two draft PRs,
preserving an immutable backup. Freshness and appropriate compatibility tests stay;
retention-only mechanisms and release requirements must be removed if irrelevant.
Do not claim readiness from tests of the superseded design.

Release separately from merge readiness: packaged mixed versions, physical device
background timing, Linux/Windows, bounded rollout and measured user benefit remain
explicit evidence requirements. No deployment or enable is authorized by this plan.

## Implementation notes — 2026-09-11

The authenticated director command carries its configured cohort percentage and
fresh process safety snapshot. A cell cannot use its own default-zero director
cohort setting to authorize or reject a selected host; it validates the authenticated
command, combines director/source safety, and rechecks durable policy, the host's
cohort bucket, and fleet/target safety inside the existing transaction. These fields
are on the internal admin endpoint, not the mobile or desktop protocol.

Candidate selection is read-only and uses a rotating page offset to progress past
busy hosts. A deterministic UUIDv5 derived from the exact source authority and target
keeps operation identity stable across director retries/restarts. Both details still
need final implementation audit and an explicit page-boundary fairness test.

Current focused and real-transport results are recorded at the top of the acceptance
document. They do not complete the remaining compatibility, cleanup and PR gates.
