import type { OrchestrationDb } from '../orchestration-db'

export function hasColumn(this: OrchestrationDb, table: string, column: string): boolean {
  const rows = this.db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.some((r) => r.name === column)
}

export function createMailboxDeliveryIndexesIfPossible(this: OrchestrationDb): void {
  if (this.hasColumn('deliveries', 'mailbox_handle')) {
    // Excluding '' trades the pre-v34 per-run one-outstanding backstop for downgraded binaries; the
    // app-level BEGIN IMMEDIATE still serializes one process.
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';
    `)
  }
  const hasDeliveredAt = this.hasColumn('messages', 'delivered_at')
  if (hasDeliveredAt) {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_undelivered_inbox
        ON messages(to_handle, read, delivered_at, sequence)
    `)
  }
  if (this.hasColumn('messages', 'pointer_enter_pending')) {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_pending_pointer_enter
        ON messages(to_handle, sequence)
        WHERE read = 0 AND pointer_enter_pending > 0;
    `)
  }

  if (
    !hasDeliveredAt ||
    !this.hasColumn('messages', 'run_id') ||
    !this.hasColumn('messages', 'delivery_contract')
  ) {
    return
  }
  this.db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_undelivered_direct_run
      ON messages(run_id, to_handle, sequence)
      WHERE read = 0 AND delivered_at IS NULL
        AND delivery_contract = 'current_delivery';
    CREATE INDEX IF NOT EXISTS idx_messages_unread_current_inbox
      ON messages(to_handle, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';
    CREATE INDEX IF NOT EXISTS idx_messages_unread_current_inbox_type
      ON messages(to_handle, type, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';
    CREATE INDEX IF NOT EXISTS idx_messages_unread_current_run_type
      ON messages(run_id, to_handle, type, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';
  `)
}

// Why: sqlite_master holds the table's CREATE SQL incl. the CHECK — cheapest reliable probe for whether it already allows 'heartbeat'.
export function messagesTypeCheckAllowsHeartbeat(this: OrchestrationDb): boolean {
  const row = this.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string } | undefined
  return !!row && row.sql.includes("'heartbeat'")
}

export function messagesTypeCheckAllowsQuestion(this: OrchestrationDb): boolean {
  const row = this.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string } | undefined
  return !!row && row.sql.includes("'question'")
}

export type SchemaColumnProbesMethods = {
  hasColumn: typeof hasColumn
  createMailboxDeliveryIndexesIfPossible: typeof createMailboxDeliveryIndexesIfPossible
  messagesTypeCheckAllowsHeartbeat: typeof messagesTypeCheckAllowsHeartbeat
  messagesTypeCheckAllowsQuestion: typeof messagesTypeCheckAllowsQuestion
}

export function attachSchemaColumnProbes(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    hasColumn,
    createMailboxDeliveryIndexesIfPossible,
    messagesTypeCheckAllowsHeartbeat,
    messagesTypeCheckAllowsQuestion
  })
}
