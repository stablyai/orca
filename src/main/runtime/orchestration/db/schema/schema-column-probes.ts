import type { OrchestrationDb } from '../orchestration-db'

export function hasColumn(this: OrchestrationDb, table: string, column: string): boolean {
  const rows = this.db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.some((r) => r.name === column)
}

export function createMailboxDeliveryIndexesIfPossible(this: OrchestrationDb): void {
  createMaestroTransferMutationIndexIfPossible(this)
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
    if (this.hasColumn('messages', 'pointer_pty_id')) {
      // Working-title frames release one PTY's reservations, including already-read rows.
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_pending_pointer_pty
          ON messages(pointer_pty_id) WHERE pointer_enter_pending > 0;
      `)
    }
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

export function createMaestroTransferMutationIndexIfPossible(db: OrchestrationDb): void {
  const columns = [
    'mutation_caller_fingerprint',
    'mutation_request_id',
    'mutation_method',
    'mutation_payload_hash'
  ]
  if (
    !columns.every((column) => db.hasColumn('maestro_terminal_lease_transfer_receipts', column))
  ) {
    return
  }
  db.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_lease_transfer_mutation
    ON maestro_terminal_lease_transfer_receipts(
      mutation_caller_fingerprint, mutation_request_id, mutation_method, mutation_payload_hash
    ) WHERE mutation_caller_fingerprint IS NOT NULL AND mutation_request_id IS NOT NULL
      AND mutation_method IS NOT NULL AND mutation_payload_hash IS NOT NULL`)
}

export function createMaestroTerminalLeaseIndexesIfPossible(db: OrchestrationDb): void {
  if (!db.hasColumn('maestro_terminal_leases', 'run_id')) {
    return
  }
  db.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_coordinator_generation
      ON maestro_terminal_leases(run_id, coordinator_generation)
      WHERE role = 'coordinator';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_worker_attempt
      ON maestro_terminal_leases(run_id, task_id, attempt_id)
      WHERE role = 'worker' AND attempt_id IS NOT NULL AND lifecycle_state != 'superseded';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_worker_resource
      ON maestro_terminal_leases(worker_terminal_resource_id)
      WHERE worker_terminal_resource_id IS NOT NULL AND lifecycle_state != 'superseded';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_live_terminal_owner
      ON maestro_terminal_leases(execution_host_id, workspace_key, terminal_handle, pty_incarnation)
      WHERE terminal_handle IS NOT NULL AND pty_incarnation IS NOT NULL
        AND lifecycle_state NOT IN ('released', 'superseded', 'archived');
    CREATE INDEX IF NOT EXISTS idx_maestro_terminal_leases_lifecycle
      ON maestro_terminal_leases(run_id, lifecycle_state, role);
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
  createMaestroTerminalLeaseIndexesIfPossible: typeof createMaestroTerminalLeaseIndexesIfPossible
  messagesTypeCheckAllowsHeartbeat: typeof messagesTypeCheckAllowsHeartbeat
  messagesTypeCheckAllowsQuestion: typeof messagesTypeCheckAllowsQuestion
}

export function attachSchemaColumnProbes(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    hasColumn,
    createMailboxDeliveryIndexesIfPossible,
    createMaestroTerminalLeaseIndexesIfPossible,
    messagesTypeCheckAllowsHeartbeat,
    messagesTypeCheckAllowsQuestion
  })
}
