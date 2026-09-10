# Orchestration delivery storage

A message records whether it still needs attention (`read`). A delivery records a stable batch ID, ordered message IDs, mailbox, consumer generation, and creation time. Acknowledgement time and fencing record actual events. There is no stored delivery status.

`outstanding_deliveries` is a SQLite view, not a table or cached projection. It selects batches that have not been acknowledged or fenced and still contain unread messages. Both consuming checks and notification eligibility query this view.

When completion makes an earlier heartbeat obsolete, only the message changes. Its batch stops appearing in the view without a second write. Checking an old database with a fully read heartbeat batch requires no repair operation. A partially read batch still replays its complete original membership under the same ID.

Acknowledgement marks the batch's messages read and records `acknowledged_at` in one transaction. A first explicit acknowledgement after lifecycle suppression records the actual event; subsequent acknowledgements are idempotent. Suppression never invents an acknowledgement timestamp. An acknowledgement cannot consume newer messages outside the batch.

Creation and acknowledgement use `BEGIN IMMEDIATE` and validate the current consumer inside that transaction. Run coordinators use the Run generation. Workers use the generation on their local Dispatch or federated attachment, according to the caller's existing routing. Loopback federation can contain both records, so the source is explicit. The insertion constraint consults the same view to prevent two outstanding batches in a mailbox, while allowing historical batches.

## Migration and compatibility

Schema v41 removes `deliveries.status` and its partial unique index. It preserves batch IDs, ordered membership, mailbox addresses, generations, creation times, and acknowledgement times. The old fenced status becomes a boolean fencing fact. The new view replaces stored eligibility; an insertion trigger replaces the old uniqueness backstop.

This is a one-way local database upgrade for shipped versions that query the removed status column. Those versions cannot open the upgraded database. Rolling the app back requires a compatible pre-upgrade database backup; this migration does not create a backup. A future reverse migration would need to materialize the old status before using an older binary.

Mixed client/server versions are a different boundary. The existing check RPC returns delivery IDs and messages, not the storage row's status. Its response shape and acknowledgement commands remain compatible, including on SSH and federated worker hosts. This migration is owned by the runtime that opens the database, not by a paired client.
