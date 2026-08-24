# Parent-loss observation contract

Status: C1 verified in `c5ebf55745`; C2 durable checkpoint/rebind is under verification.

An active dispatched worker remains parent-controlled. The runtime projects
`parentIdentity`, `parentRuntimeEpoch`, `parentStatus`, `inputPolicy`, `rebindStatus`, and
`checkpointId`. A selected but non-live parent produces `parentStatus=FROZEN`,
`inputPolicy=FROZEN`, and `rebindStatus=APPROVAL_REQUIRED`.

This state rejects worker-originated `send`, `reply`, task mutation, dispatch, and `ask` before DB
effects. Read-only observation remains available. It never promotes the worker, closes its terminal,
deletes files, reuses its dispatch, or changes an environment variable. C2 stores a SHA-256
checkpoint, claims one bounded rebind lease, requires an explicit `human:*` approver and unique
`approvalId` evidence, and requires the new parent handle to resolve to the exact live local pane.
It increments the coordinator epoch, fails the old Dispatch, and creates a new Dispatch plus new
correlation ID for the existing worker identity. Duplicate or non-positive/expired lease attempts
fail before effects. No cross-plane fallback is automatic.

Graphify is a read-only projection consumer. It may display revision, verification, and degraded
state, but has no implementation, lease, dispatch, checkpoint, or rebind authority.
