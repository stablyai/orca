import type { OrchestrationDb } from '../orchestration-db'
import { OUTSTANDING_MAILBOX_INDEX_SQL } from './migrate-v41'
import {
  DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL,
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'

export function hasColumn(this: OrchestrationDb, table: string, column: string): boolean {
  const rows = this.db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.some((r) => r.name === column)
}

export function createMailboxDeliveryIndexesIfPossible(this: OrchestrationDb): void {
  if (
    ['assignee_orca_session_id', 'status', 'completed_at'].every((column) =>
      this.hasColumn('dispatch_contexts', column)
    )
  ) {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_session_presentation
      ON dispatch_contexts(status, completed_at) WHERE assignee_orca_session_id IS NOT NULL`)
  }
  if (this.hasColumn('deliveries', 'mailbox_handle')) {
    this.db.exec(OUTSTANDING_MAILBOX_INDEX_SQL)
  }
  if (this.hasColumn('messages', 'created_at')) {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_crew_from
        ON messages(from_handle, julianday(created_at), to_handle, sequence) WHERE type <> 'heartbeat';
      CREATE INDEX IF NOT EXISTS idx_messages_crew_to
        ON messages(to_handle, julianday(created_at), from_handle, sequence) WHERE type <> 'heartbeat';
    `)
  }
  if (this.hasColumn('dispatch_contexts', 'completed_at')) {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_dispatch_crew_recent
      ON dispatch_contexts(julianday(completed_at)) WHERE status NOT IN ('pending', 'dispatched');`)
  }
  if (this.hasColumn('dispatch_contexts', 'assignee_pane_key')) {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_crew_dispatch_pane
      ON dispatch_contexts(assignee_pane_key) WHERE assignee_pane_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_crew_dispatch_leaf
      ON dispatch_contexts(${DISPATCH_PANE_KEY_MATCH_SUFFIX_SQL}) WHERE assignee_pane_key IS NOT NULL`)
  }
  if (this.hasColumn('remote_dispatch_attachments', 'terminal_handle')) {
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_crew_remote_handle ON remote_dispatch_attachments(terminal_handle);
      CREATE INDEX IF NOT EXISTS idx_crew_remote_pane ON remote_dispatch_attachments(pane_key);
      CREATE INDEX IF NOT EXISTS idx_crew_remote_leaf ON remote_dispatch_attachments(${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL}) WHERE pane_key IS NOT NULL;
    `)
  }
  if (this.hasColumn('worker_terminal_resources', 'pane_key')) {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_crew_resource_leaf
      ON worker_terminal_resources(${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL}) WHERE pane_key IS NOT NULL`)
  }
  if (this.hasColumn('question_threads', 'status')) {
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_crew_pending_questions
      ON question_threads(message_id) WHERE status = 'pending'`)
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

// Probe sqlite_master's CHECK to verify heartbeat support without rebuilding.
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
