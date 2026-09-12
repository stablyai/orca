# Orchestration delivery storage

A message records whether it still needs attention (`read`). A delivery is a stable batch receipt: ID, ordered message IDs, mailbox, consumer generation, creation time, and `status`. `status` only records terminal facts written by an explicit event: `acknowledged` when the consumer acks, `fenced` when the consumer is replaced or legacy ownership is adopted. `outstanding` means neither has happened; it does not mean the batch is still eligible.

Eligibility is derived, never stored. `outstanding_deliveries` is a SQLite view over batches that are `outstanding` and still contain at least one unread message. Consuming checks, replay, notification pointers, and the single-active-batch insert trigger all read this view. When lifecycle reconciliation marks a heartbeat read, its batch stops appearing without any delivery write, so a later `worker_done` is never hidden behind it. A partially read batch still replays its complete original membership under the same ID.

Creation and acknowledgement run under `BEGIN IMMEDIATE` and validate the current consumer inside that transaction: Run coordinators against the Run generation, workers against their local Dispatch or federated attachment, chosen explicitly by the caller because a loopback runtime has both. Worker validation also requires a live lifecycle state, so a settled worker cannot consume mail awaiting rerouting; remote states with unverifiable liveness stay eligible.

## Compatibility

Schema v41 drops the unique constraint from `idx_deliveries_one_outstanding` (name and predicate unchanged) and adds the view and trigger. No column changes. An older binary that opens a v41 database keeps working: it sees a higher `user_version` and skips migration, its `status` queries still resolve, and the index it expects still exists.
