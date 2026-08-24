# Parent-loss observation contract

Status: C1 implementation in progress. C2 rebind authority is not implemented.

An active dispatched worker remains parent-controlled. The runtime projects
`parentIdentity`, `parentRuntimeEpoch`, `parentStatus`, `inputPolicy`, `rebindStatus`, and
`checkpointId`. A selected but non-live parent produces `parentStatus=FROZEN`,
`inputPolicy=FROZEN`, and `rebindStatus=APPROVAL_REQUIRED`.

This state rejects worker-originated `send`, `reply`, task mutation, dispatch, and `ask` before DB
effects. Read-only observation remains available. It never promotes the worker, closes its terminal,
deletes files, reuses its dispatch, or changes an environment variable. A durable checkpoint may
move the state to `CHECKPOINTED`; only C2 may create that checkpoint and a new dispatch/coordinator
epoch after explicit approval. Until that mutation contract exists, the UI describes checkpoint and
approval as requirements rather than completed actions.

Graphify is a read-only projection consumer. It may display revision, verification, and degraded
state, but has no implementation, lease, dispatch, checkpoint, or rebind authority.
