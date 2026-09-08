# Journal recovery generations

Opening a corrupt journal used to delete its first rejected row and every later
row. Provider transcripts cannot restore Orca-only submission receipts. Repair
now seals the original epoch and publishes only the readable prefix in a fresh
epoch. The suffix remains recovery evidence, never automatically replayed across
an unknown dependency.

## Ownership and transaction

The execution host owns the SQLite journal and the repair, using the existing
journal connection and `BEGIN IMMEDIATE` / `synchronous = FULL` transaction. This
has no Git dependency: folder workspaces and Git worktrees use the same operation.
No client-side repair, transport fallback, RPC field, or stream opcode is added.
An old cursor uses the existing `epoch_changed` reset.

Schema v3 adds `journal_recovery_epochs`. Each row records the sealed source
session/epoch, replacement epoch, rejected sequence, readable prefix boundary,
seal time, row count, and raw JSON byte count. Original `journal_rows` remain
in place, preserving their exact sequence, timestamp, epoch, and bytes. Triggers
refuse inserts, updates, or deletes in sealed epochs and mutation of recovery
metadata. Ordinary epoch replacement deletes only unsealed rows.

The transaction rechecks the load under the write lock, registers the seal,
inserts the prefix with the new epoch identity (or an anchor for an empty prefix),
records the outstanding rebuild marker, and moves the session projection. Only a
successful commit is adopted in memory. A failure refuses open; rollback leaves
the original rows and projection intact. An abrupt exit after commit leaves the
complete new generation and original evidence. Disclosure is a subsequent append;
its absence after a crash does not remove the repair marker or the evidence.

Existing v1/v2 databases migrate transactionally with the schema version bump.
Older hosts see v3 as a future database and latch read-only. Database and row
versions are independent: future row versions in TEXT or valid UTF-8 BLOBs,
including behind malformed rows, are checked before persistent pragmas or migration.
Admission and replay share raw SQLite value decoding. Invalid UTF-8 and unsupported
value types conservatively latch read-only; supported malformed JSON can be sealed
and repaired. Decoding never rewrites the original storage type or bytes. No
future-version database is repaired. A schema-scoped provider reconstruction, where already supported, is a
separate journal and never authorizes modifying the original.

## Recovery and capacity boundary

Sealed rows are available on the execution host through the existing SQL row
storage. For byte-exact extraction, use `CAST(row_json AS BLOB)` and select by the
source session and epoch from `journal_recovery_epochs`; retain `seq`, `ts`, and
`typeof(row_json)` so extraction also preserves the SQLite storage class.
A valid-looking receipt behind a rejected row is recoverable evidence, not proof
that it can safely be applied to the live generation. No recovery UI or automatic
suffix merge is added here.

The immutable ownership records make recovery occupancy discoverable for the
coordinated storage budget. `row_bytes` measures logical JSON bytes only; it is
**not** a physical capacity budget. A future admission policy must count sealed
rows alongside live rows, database pages, WAL, payloads, staging, and checkpoint
peak, and must reserve the prefix-copy peak before admitting repair. SQLite
allocation failure currently refuses repair without deleting the source. There
is no application quota, reclamation of sealed epochs, payload storage, or bounded
retention in this change (STA-6924 and STA-6837 remain separate work).

## Validation contract

Shipping-path tests cover byte equality through repair, reopen, and subsequent
epoch replacement; immutable seals; refusal at transaction stages; SQLite
`max_page_count` exhaustion; future DB/row versions; and abrupt child-process exit
before/after commit. Page-limit exhaustion exercises SQLite's real `SQLITE_FULL`
path without filling the host disk. Process exits exercise recovery of uncommitted
WAL transactions, not hardware power-loss guarantees.

Run with `pnpm exec vitest run --config config/vitest.config.ts
src/main/native-chat/agent-session-journal`. Platform, paired-host, and client
version-skew runtime coverage must be reported explicitly by each validation run.
