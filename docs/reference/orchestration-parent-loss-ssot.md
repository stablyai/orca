# Parent-loss observation contract

Status after the 2026-08-25 upstream rebase: C1 observation and the C2 checkpoint/rebind mechanics
are implemented in PR #16349. C2 is not yet a verified human-approved rebind contract because its
approval evidence is still supplied by the request rather than minted and consumed by a
server-owned human-approval ledger.

An active dispatched worker remains parent-controlled. The runtime projects
`parentIdentity`, `parentRuntimeEpoch`, `parentStatus`, `inputPolicy`, `rebindStatus`, and
`checkpointId`. A selected but non-live parent produces `parentStatus=FROZEN`,
`inputPolicy=FROZEN`, and `rebindStatus=APPROVAL_REQUIRED`.

This state rejects worker-originated `send`, `reply`, task mutation, dispatch, and `ask` before DB
effects. Read-only observation remains available. It never promotes the worker, closes its terminal,
deletes files, reuses its dispatch, or changes an environment variable. C2 stores a SHA-256
checkpoint, claims one bounded rebind lease, rejects legacy Runs atomically, and requires the new
parent handle to resolve to the exact live local pane. It increments the coordinator epoch, fails
the old Dispatch, and creates a new Dispatch plus new correlation ID for the existing worker
identity. Duplicate or non-positive/expired lease attempts fail before effects. No cross-plane
fallback is automatic.

`approvedBy` and `approvalId` currently prove only that non-empty request fields were persisted.
They do not prove that an authenticated person approved this exact checkpoint, new parent, and pane.
Therefore Graphify and Chief must project C2 as `APPROVAL_AUTHORITY_HOLD`, not
`VERIFIED_COMPLETE`. The release condition is a server-owned one-time approval record bound to the
checkpoint, target handle, target pane, authenticated human surface, expiry, and consumption receipt.

Graphify is a read-only projection consumer. It may display revision, verification, and degraded
state, but has no implementation, lease, dispatch, checkpoint, or rebind authority.
