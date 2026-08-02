# Orchestration conversation wake

Orca has a disabled-by-default runtime foundation for waking an Orca-owned control conversation after a supervised Run commits `worker_done`, `escalation`, `decision_gate`, or `question` mail.

## Safety boundary

- `ORCA_FEATURE_ORCHESTRATION_CONVERSATION_WAKE=1` enables the foundation.
- `ORCA_DISABLE_ORCHESTRATION_CONVERSATION_WAKE=1` is the runtime kill switch and is checked before inspection, claim, submission, and acceptance persistence.
- No production provider is registered yet. The current Codex integration opens short-lived maintenance `app-server` sessions and does not own a resumable control conversation or expose safe turn start/terminal operations.
- Unmanaged PTYs, unsupported providers, missing conversations, and stale Run consumer generations fail closed. This path never writes PTY bytes, submits Enter, or interrupts an active turn.

## Runtime contract

An adapter must prove that Orca owns the provider conversation before calling `bindOrchestrationConversationWake`. A binding records the Run consumer generation, provider, and opaque conversation ID. One active provider conversation can belong to only one Run. Rebinding or moving the Run consumer fences the prior binding and all unsubmitted jobs, then deterministically backfills eligible unread mail for the new generation.

The adapter must implement `ConversationWakeProvider`:

- `getState` returns `idle`, `active`, `missing`, or `unsupported`.
- `prepareAndFinalizeTurn` serializes by conversation and honors the generation-scoped idempotency key. Before calling `commitPrepared`, it must durably prepare the exact turn so a successful callback can always be recovered and finalized after a crash. Recovery requests carry `acceptedTurnId` and must finalize that exact preparation without creating another turn. A rejected callback must produce no provider turn.
- `onTurnTerminal` is mandatory. It notifies the service after an active turn terminates so queued work can reconcile without interruption; providers that cannot register this callback are rejected.

Wake authority comes only from trusted current or compatibility Dispatch, question, or federated commit paths. Those paths persist Task and Dispatch provenance after their own DB and capability reconciliation. Mailbox addresses, sender strings, and payload identifiers never grant authority, so an arbitrary `send` remains wake-ineligible even if it resembles Dispatch mail. The provider receives the persisted identifiers as structured fields, while the fixed prompt contains no payload text or identifiers. It asks the conversation to check the durable mailbox; it does not mark the message read or delivered and does not acknowledge a Run Delivery. If the unread message is consumed before provider acceptance, the job is cancelled.

For eligible local `orchestration.send` events, message insertion, lifecycle reconciliation or worker settlement, and trusted provenance are one SQLite transaction. Any failure rolls back all three; provenance receives the already verified Task and Dispatch lineage directly and never reconstructs authority from message fields.

## Durability

Schema v24 stores bindings, trusted commit provenance, and wake jobs. Job identity includes message ID and Run consumer generation, so remint backfill cannot collide with fenced work. Startup reconciliation scans unread mail carrying trusted provenance before processing jobs, covering a crash between trusted commit and the post-commit hook.

Jobs move through `pending`, `waiting_for_idle`, `retry_wait`, and `submitting`. A successful `commitPrepared` moves the job to recoverable `accepted`; only exact provider finalization moves it to `submitted`. Run remint fences work that has not reached `accepted`, while already accepted preparations remain recoverable and must finalize with their original turn ID. Result mismatches and unrecoverable accepted work become explicit `blocked_inconsistent`; ordinary unsupported work uses `blocked`, and `cancelled` and `fenced` remain terminal. Acceptance leases and retry deadlines survive restart, transient failures use bounded exponential backoff, and service disposal clears retry timers.
