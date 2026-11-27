import type { OrchestrationDb } from '../orchestration-db'
import { projectionMutationTriggers } from '../projection-mutation-triggers'

const table = 'run_retirement'
// Trigger bodies may not qualify the tables they write; a TEMP trigger finds its TEMP tables first.
const watched = (key: string) => `INSERT OR IGNORE INTO ${table}_dirty(key)
 SELECT ${key} WHERE EXISTS (SELECT 1 FROM ${table}_tracked WHERE key = ${key});`
const byRun = (column: string) => (row: string) => watched(`'run:' || ${row}.${column}`)
const byDispatch =
  (...columns: string[]) =>
  (row: string) =>
    columns.map((column) => watched(`'dispatch:' || ${row}.${column}`)).join(' ')
const byPrincipal = (row: string) => watched(`'principal:' || ${row}.principal_id`)
const byMessage = (row: string) =>
  watched(`'run:' || (SELECT run_id FROM messages WHERE id = ${row}.message_id)`)

// Every row a retirement deletes or reads to keep a Run, keyed to its Run, one of its Dispatches or
// legacy principals, or a mailbox. Dispatch and principal keys are taken when the watch starts, so
// they still match once those rows are deleted. A message's child is keyed by its mailbox as well,
// since its message may already be gone.
const WATCHED_TABLES = [
  { table: 'runs', mark: byRun('id') },
  ...[
    'tasks',
    'dispatch_contexts',
    'messages',
    'deliveries',
    'question_threads',
    'decision_gates',
    'run_coordinator_handles',
    'legacy_compatibility_principals',
    'peer_runs',
    'remote_run_links',
    'remote_placements',
    'remote_dispatches',
    'remote_owned_questions'
  ].map((name) => ({ table: name, mark: byRun('run_id') })),
  { table: 'legacy_adoptions', mark: byRun('adopted_run_id') },
  ...[
    'worker_terminal_archives',
    'federation_relay_items',
    'federation_relay_sequences',
    'remote_questions',
    'remote_dispatch_attachments',
    'attempt_observation_facts',
    'federated_dispatches',
    'worker_dispatches'
  ].map((name) => ({ table: name, mark: byDispatch('dispatch_id') })),
  {
    table: 'worker_terminal_resources',
    mark: byDispatch('owner_dispatch_id', 'origin_dispatch_id')
  },
  {
    table: 'message_dispatch_provenance',
    mark: (row: string) => `${byDispatch('dispatch_id')(row)} ${byMessage(row)}`
  },
  {
    table: 'structured_mail_sends',
    mark: (row: string) => `${byMessage(row)} ${watched(`${row}.mailbox_handle`)}`
  },
  { table: 'legacy_operation_receipts', mark: byPrincipal },
  { table: 'legacy_mail_receipts', mark: byPrincipal },
  {
    table: 'structured_pointer_operations',
    mark: (row: string) => watched(`${row}.mailbox_handle`)
  }
]

const installed = new WeakSet<OrchestrationDb>()

// Connection-local, so they see every write only because this connection is the database's one
// writer; they roll back with their write, and nothing persists for older builds.
function install(db: OrchestrationDb): void {
  if (installed.has(db)) {
    return
  }
  db.db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${table}_tracked(key TEXT PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS ${table}_dirty(key TEXT PRIMARY KEY) WITHOUT ROWID;
    ${projectionMutationTriggers(
      table,
      WATCHED_TABLES,
      '',
      `EXISTS (SELECT 1 FROM ${table}_tracked)`
    )}`)
  installed.add(db)
}

/** Starts noticing any write to the Run's rows, until `unwatchRetiringRun`. */
export function watchRetiringRun(db: OrchestrationDb, runId: string): void {
  install(db)
  db.db.exec(`DELETE FROM temp.${table}_tracked; DELETE FROM temp.${table}_dirty`)
  db.db.prepare(`INSERT INTO temp.${table}_tracked VALUES ('run:' || ?)`).run(runId)
  db.db
    .prepare(
      `INSERT INTO temp.${table}_tracked
         SELECT 'dispatch:' || id FROM dispatch_contexts WHERE run_id = ?1
         UNION SELECT 'principal:' || id FROM legacy_compatibility_principals
           -- Its every role, so the lookup can use the (role, run_id) index.
           WHERE role IN ('coordinator', 'worker') AND run_id = ?1`
    )
    .run(runId)
}

/** Whether a mailbox is the retiring Run's own or one of its Dispatches'. */
export function isRetiringRunMailbox(db: OrchestrationDb, mailbox: string): boolean {
  return Boolean(db.db.prepare(`SELECT 1 FROM temp.${table}_tracked WHERE key = ?`).get(mailbox))
}

/** Whether anything wrote to the Run since the last `forgetRetiringRunWrites`. */
export function isRetiringRunWritten(db: OrchestrationDb): boolean {
  return Boolean(db.db.prepare(`SELECT 1 FROM temp.${table}_dirty LIMIT 1`).get())
}

/** Retirement's own deletes mark the Run too; each step forgets them before it commits. */
export function forgetRetiringRunWrites(db: OrchestrationDb): void {
  db.db.prepare(`DELETE FROM temp.${table}_dirty`).run()
}

export function unwatchRetiringRun(db: OrchestrationDb): void {
  db.db.exec(`DELETE FROM temp.${table}_tracked; DELETE FROM temp.${table}_dirty`)
}
