import type Database from '../../sqlite/sync-database'

const POST_V6_COLUMNS = [
  ['messages', 'run_id'],
  ['tasks', 'run_id'],
  ['dispatch_contexts', 'run_id'],
  ['dispatch_contexts', 'capability_hash'],
  ['dispatch_contexts', 'process_incarnation'],
  ['dispatch_contexts', 'capability_revoked_at'],
  ['decision_gates', 'run_id'],
  ['question_threads', 'run_id'],
  ['worker_dispatches', 'runtime_epoch'],
  ['federated_dispatches', 'to_home_imported_sequence'],
  ['remote_dispatch_attachments', 'to_worker_imported_sequence'],
  ['remote_dispatch_attachments', 'protocol_version'],
  ['federation_relay_items', 'dispatch_id'],
  ['remote_questions', 'message_id']
] as const

const POST_V6_INDEXES = [
  'idx_messages_run_sequence',
  'idx_tasks_run_status',
  'idx_dispatch_run_status',
  'idx_gates_run_status',
  'idx_runs_coordinator_pane',
  'idx_deliveries_one_outstanding',
  'idx_deliveries_run_created',
  'idx_questions_dispatch_status',
  'idx_federation_relay_pending',
  'idx_remote_questions_dispatch_status'
] as const

function hasOrchestrationColumn(db: Database.Database, table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string }[]
  return rows.some((row) => row.name === column)
}

function hasOrchestrationIndex(db: Database.Database, index: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)
}

function messagesAllowQuestions(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string } | undefined
  return !!row && row.sql.includes("'question'")
}

function hasCompletePostV6Schema(db: Database.Database): boolean {
  return (
    POST_V6_COLUMNS.every(([table, column]) => hasOrchestrationColumn(db, table, column)) &&
    POST_V6_INDEXES.every((index) => hasOrchestrationIndex(db, index)) &&
    messagesAllowQuestions(db)
  )
}

export function resolveOrchestrationMigrationStartVersion(
  db: Database.Database,
  storedVersion: number,
  schemaVersion: number
): number {
  if (storedVersion >= schemaVersion || hasCompletePostV6Schema(db)) {
    return storedVersion
  }
  // Why: version-skewed pre-Run databases can claim the post-v6 range while retaining v6 tables.
  return Math.min(storedVersion, 6)
}
