import type Database from '../../sqlite/sync-database'

const POST_V6_COLUMNS = [
  ['messages', 'run_id'],
  ['messages', 'delivery_contract'],
  ['coordinator_runs', 'scheduler_lost_at'],
  ['tasks', 'run_id'],
  ['dispatch_contexts', 'run_id'],
  ['dispatch_contexts', 'contract_version'],
  ['dispatch_contexts', 'launch_token_hash'],
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
  ['remote_questions', 'message_id'],
  ['legacy_adoptions', 'source_run_id'],
  ['legacy_compatibility_principals', 'id'],
  ['legacy_operation_receipts', 'principal_id'],
  ['legacy_mail_receipts', 'principal_id']
] as const

const VERSIONED_POST_V6_COLUMNS = [
  { version: 27, table: 'federated_dispatches', column: 'to_home_acknowledged_sequence' },
  { version: 30, table: 'dispatch_contexts', column: 'depth' },
  { version: 30, table: 'remote_dispatch_attachments', column: 'depth' },
  { version: 31, table: 'dispatch_contexts', column: 'retry_of_dispatch_id' },
  { version: 31, table: 'dispatch_contexts', column: 'creator_dispatch_id' },
  { version: 31, table: 'dispatch_contexts', column: 'host_scope' },
  { version: 31, table: 'worker_terminal_resources', column: 'endpoint_id' },
  { version: 31, table: 'worker_terminal_resources', column: 'endpoint_incarnation' },
  // Why: unversioned, these made every shipped v30 database read as v6 and replay the whole chain.
  { version: 32, table: 'worker_terminal_resources', column: 'recovery_attempt_count' },
  { version: 32, table: 'worker_terminal_resources', column: 'last_recovery_at' },
  { version: 33, table: 'messages', column: 'pointer_enter_pending' },
  { version: 34, table: 'deliveries', column: 'mailbox_handle' },
  { version: 36, table: 'dispatch_contexts', column: 'consumer_generation' },
  { version: 36, table: 'remote_dispatch_attachments', column: 'consumer_generation' },
  { version: 37, table: 'dispatch_contexts', column: 'creator_handle' },
  { version: 37, table: 'dispatch_contexts', column: 'creator_pane_key' }
] as const

// Why: v34 shipped without these two, so a v34 stamp proves nothing about them; v35 repairs both
// and this list keeps a partially-written v35 from claiming the repair.
const VERSIONED_POST_V6_COLUMN_DEFAULTS = [
  { version: 35, table: 'deliveries', column: 'mailbox_handle', defaultValue: "''" }
] as const

const VERSIONED_POST_V6_INDEX_PREDICATES = [
  { version: 35, index: 'idx_deliveries_one_outstanding', predicate: "mailbox_handle != ''" },
  {
    version: 35,
    index: 'idx_messages_pending_pointer_enter',
    predicate: 'pointer_enter_pending > 0'
  }
] as const

const POST_V6_INDEXES = [
  'idx_messages_run_sequence',
  'idx_messages_delivery_contract',
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

function hasNotNullOrchestrationColumn(
  db: Database.Database,
  table: string,
  column: string
): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string; notnull: number }[]
  return rows.some((row) => row.name === column && row.notnull === 1)
}

function hasOrchestrationColumnDefault(
  db: Database.Database,
  table: string,
  column: string,
  defaultValue: string
): boolean {
  const rows = db.pragma(`table_info(${table})`) as { name: string; dflt_value: unknown }[]
  return rows.some((row) => row.name === column && row.dflt_value === defaultValue)
}

function hasOrchestrationIndex(db: Database.Database, index: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index)
}

function hasOrchestrationIndexPredicate(
  db: Database.Database,
  index: string,
  predicate: string
): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(index) as { sql: string | null } | undefined
  return !!row?.sql?.includes(predicate)
}

function messagesAllowQuestions(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get() as { sql: string } | undefined
  return !!row && row.sql.includes("'question'")
}

function hasConsistentLegacyAdoption(db: Database.Database): boolean {
  const sourceRunId = 'run_legacy_local'
  const sourceGraph = db
    .prepare(
      `SELECT 1
       WHERE EXISTS(SELECT 1 FROM tasks WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM dispatch_contexts WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM decision_gates WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM messages WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM question_threads WHERE run_id = ?)
          OR EXISTS(SELECT 1 FROM deliveries WHERE run_id = ?)`
    )
    .get(sourceRunId, sourceRunId, sourceRunId, sourceRunId, sourceRunId, sourceRunId)
  const adoption = db
    .prepare('SELECT adopted_run_id FROM legacy_adoptions WHERE source_run_id = ?')
    .get(sourceRunId) as { adopted_run_id: string } | undefined
  if (sourceGraph) {
    return false
  }
  if (adoption) {
    return Boolean(
      db.prepare('SELECT 1 FROM runs WHERE id = ? AND legacy = 0').get(adoption.adopted_run_id)
    )
  }
  return true
}

function hasCompletePostV6Schema(db: Database.Database, storedVersion: number): boolean {
  return (
    POST_V6_COLUMNS.every(([table, column]) => hasOrchestrationColumn(db, table, column)) &&
    VERSIONED_POST_V6_COLUMNS.every(
      ({ version, table, column }) =>
        storedVersion < version || hasOrchestrationColumn(db, table, column)
    ) &&
    (storedVersion < 34 || hasNotNullOrchestrationColumn(db, 'deliveries', 'mailbox_handle')) &&
    VERSIONED_POST_V6_COLUMN_DEFAULTS.every(
      ({ version, table, column, defaultValue }) =>
        storedVersion < version || hasOrchestrationColumnDefault(db, table, column, defaultValue)
    ) &&
    VERSIONED_POST_V6_INDEX_PREDICATES.every(
      ({ version, index, predicate }) =>
        storedVersion < version || hasOrchestrationIndexPredicate(db, index, predicate)
    ) &&
    POST_V6_INDEXES.every((index) => hasOrchestrationIndex(db, index)) &&
    messagesAllowQuestions(db) &&
    hasConsistentLegacyAdoption(db)
  )
}

export function resolveOrchestrationMigrationStartVersion(
  db: Database.Database,
  storedVersion: number,
  schemaVersion: number
): number {
  if (storedVersion > schemaVersion) {
    return storedVersion
  }
  if (hasCompletePostV6Schema(db, storedVersion)) {
    return storedVersion
  }
  // Why: version-skewed pre-Run databases can claim the post-v6 range while retaining v6 tables.
  return Math.min(storedVersion, schemaVersion, 6)
}
