import type { OrchestrationDb } from '../orchestration-db'
import { ADDITIVE_LIFECYCLE_DELETE_TRIGGERS_SQL } from './create-graph-tables-sql'

const ONE_OUTSTANDING_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_deliveries_one_outstanding
    ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
`
const PENDING_POINTER_ENTER_INDEX_SQL = `
  CREATE INDEX idx_messages_pending_pointer_enter
    ON messages(to_handle, sequence)
    WHERE read = 0 AND pointer_enter_pending > 0;
`

/** v31 identity columns that were never read back; creator_dispatch_id, host_scope, depth, and
 *  retry_of_dispatch_id (published as `retryOfDispatchId`) stay. */
const DROPPED_DISPATCH_IDENTITY_COLUMNS = [
  'creator_role',
  'endpoint_id',
  'endpoint_incarnation',
  'attachment_kind',
  'resource_id'
] as const

/**
 * Databases stamped v34 by the pre-fix build kept the old deliveries shape: v34 early-returns at
 * `>= 34`, and every index probe uses IF NOT EXISTS, so whichever predicate ran first survives.
 * Re-apply both halves against the stored SQL rather than the version stamp.
 */
export function migrateV35(this: OrchestrationDb, current: number): void {
  if (current >= 35) {
    return
  }
  // The write-only lifecycle ledger is gone. Old delete triggers still reference it, and
  // CREATE TRIGGER IF NOT EXISTS cannot replace a body, so drop all three and rebuild the two
  // that survive.
  this.db.exec(`
    DROP TRIGGER IF EXISTS trg_tasks_delete_additive_lifecycle;
    DROP TRIGGER IF EXISTS trg_dispatches_delete_additive_lifecycle;
    DROP TRIGGER IF EXISTS trg_workers_delete_additive_lifecycle;
    DROP TABLE IF EXISTS lifecycle_transition_receipts;
    ${ADDITIVE_LIFECYCLE_DELETE_TRIGGERS_SQL}
  `)
  rebuildDeliveriesWithMailboxDefault.call(this)
  recreateIndexMissingPredicate.call(
    this,
    'idx_deliveries_one_outstanding',
    "mailbox_handle != ''",
    ONE_OUTSTANDING_INDEX_SQL
  )
  recreateIndexMissingPredicate.call(
    this,
    'idx_messages_pending_pointer_enter',
    'pointer_enter_pending > 0',
    PENDING_POINTER_ENTER_INDEX_SQL
  )
  dropUnreadDispatchIdentityColumns.call(this)
}

function rebuildDeliveriesWithMailboxDefault(this: OrchestrationDb): void {
  const mailboxColumn = (
    this.db.pragma('table_info(deliveries)') as { name: string; dflt_value: unknown }[]
  ).find((column) => column.name === 'mailbox_handle')
  if (!mailboxColumn || mailboxColumn.dflt_value !== null) {
    return
  }
  this.db.exec(`
    CREATE TABLE deliveries_v35 (
      id                    TEXT PRIMARY KEY,
      run_id                TEXT NOT NULL,
      mailbox_handle        TEXT NOT NULL DEFAULT '',
      consumer_generation   INTEGER NOT NULL,
      message_ids           TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'outstanding'
        CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
      created_at            TEXT NOT NULL DEFAULT (datetime('now')),
      acknowledged_at       TEXT
    );
    INSERT INTO deliveries_v35 (
      id, run_id, mailbox_handle, consumer_generation, message_ids,
      status, created_at, acknowledged_at
    )
    SELECT
      id, run_id, COALESCE(mailbox_handle, 'run:' || run_id), consumer_generation, message_ids,
      status, created_at, acknowledged_at
    FROM deliveries;
    DROP TABLE deliveries;
    ALTER TABLE deliveries_v35 RENAME TO deliveries;

    ${ONE_OUTSTANDING_INDEX_SQL}
    CREATE INDEX IF NOT EXISTS idx_deliveries_run_created
      ON deliveries(run_id, created_at);
  `)
}

function recreateIndexMissingPredicate(
  this: OrchestrationDb,
  index: string,
  predicate: string,
  createSql: string
): void {
  const stored = this.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index) as { sql: string | null } | undefined
  if (stored?.sql?.includes(predicate)) {
    return
  }
  this.db.exec(`DROP INDEX IF EXISTS ${index};\n${createSql}`)
}

function dropUnreadDispatchIdentityColumns(this: OrchestrationDb): void {
  // SQLite refuses DROP COLUMN while an index still references the column.
  this.db.exec(`
    DROP INDEX IF EXISTS idx_dispatch_retry_of;
    DROP INDEX IF EXISTS idx_dispatch_resource;
  `)
  for (const column of DROPPED_DISPATCH_IDENTITY_COLUMNS) {
    if (this.hasColumn('dispatch_contexts', column)) {
      this.db.exec(`ALTER TABLE dispatch_contexts DROP COLUMN ${column}`)
    }
  }
}
