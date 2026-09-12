# Idle regional correction contracts

Updated 2026-09-11. The [idle-cutover plan](RELAY-REGION-CORRECTION-IDLE-CUTOVER-PLAN.md)
is authoritative. This replaces the former retention/restoration protocol.

## Desktop measurement and capability

The optional assignment `regionCorrection` namespace supports `issue-window` and
`report`. The server issues a generation, fixed expiry, assignment epoch, incumbent
region and policy version1. A report supplies measurements for both regions or an
inconclusive reason. The first accepted report remains immutable; stale or changed
assignment evidence cannot authorize a move. Legacy placement hints remain separate.

Desktop advertises `idle-regional-rehome-v1` in its control capability header.
There is no new mobile message, retained-control lease, or restoration notification.
The cell persists the exact activity, generation, assignment and incarnation with
`idle_regional_rehome`. The obsolete `finish_existing` database column is always
written0 for schema compatibility and is not an eligibility signal.

## Director to source cell

`POST /v1/admin/host-idle-rehome` requires the configured director identity and
matching source cell/incarnation. The strict request contains:

- `v:1`, stable UUID `attemptId`, `userId`, `relayHostId`;
- `sourceCellId`, `sourceCellIncarnation`, `sourceAssignmentEpoch`, `sourceGeneration`;
- `targetCellId`, authenticated `cohortPercent`, and fresh `directorSafety`.

The strict response is `{v:1,outcome}` with `busy`, `committed`, `deferred`, or
`stale`. A lost HTTP reply is ambiguous and does not consume a dispatch-failure
budget. Repeat delivery retains the same operation identity. Cell status advertises
regional protocol3; new selection requires both cells at protocol3 or newer.

## Store and source ownership

`selectIdleRegionalRehomeCandidates` is read-only. It checks fresh evidence,
capability, policy, cooldown, telemetry and target capacity; bounded rotating pages
allow progress past busy hosts. Selection does not prove physical idleness.

`HostSessionRegistry.idleRehome` accounts for accepts, attaches, control commands,
and activation before their first await. Only an idle source installs its admission
gate. New arrivals receive normal retryable routing failure. Conflicting reuse of
an operation ID cannot share another authority tuple's result.

`commitIdleRegionalRehome` rechecks the exact request under existing locks, including
policy, cohort, capacity, global rate and concurrency. It atomically reserves the
target, advances assignment and records the attempt/source generation. It does not
choose a different host or destination. Completion is recorded at the source;
ordinary migration refresh, completion and expiry recovery remain responsible for
the target-registration lifecycle.

`reconcileIdleRegionalRehome` locks the assignment before reading the operation.
It distinguishes committed, not-committed with unchanged live source authority,
and stale authority. Missing data after an unlocked read is never rollback proof.
A database error leaves admissions fenced while reconciliation retries. Successful
cutover closes/releases the empty source control; the desktop resolves its normal
assignment and reconnects. Definite rollback reopens only the same source authority.

Outcome reporting aggregates actual attempts and migrations by cell/state, without
host identities or a retained-source table. A completed idle move does not authorize
closing future clients attached to the target.
