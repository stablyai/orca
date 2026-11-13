import { JournalLegacyRetentionError } from './journal-legacy-retention-error'
import { journalOpenRefusal } from './replay/journal-open-failure'
import { readStoredQueuedMessageRow } from './queued-messages/queued-message-stored-row'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalSqlConversions } from './journal-sql-conversions'
import type { JournalSqlOwner } from './journal-sql-owner'
import type Database from '../../sqlite/sync-database'

const PROFILE_TABLES = new Set([
  'agent_session_records',
  'agent_session_operations',
  'agent_session_retired_claim_keys',
  'agent_session_tabs',
  'agent_session_store_meta',
  'agent_session_command_receipts',
  'agent_session_attachment_claims',
  'agent_session_attachment_sweeps',
  'pr_chat_actions',
  'pr_check_events',
  'pr_event_deliveries',
  'pr_pending_heads',
  'pr_pending_actions',
  'pr_check_contexts',
  'sqlite_sequence'
])
const CONTENT_TABLES = [
  'journal_rows',
  'journal_outcome_generations',
  'journal_outcome_epochs',
  'journal_outcomes',
  'queued_messages'
] as const
const SOURCE_COLUMNS: Readonly<Record<string, string>> = {
  journal_sessions: 'session_id workspace_id epoch',
  journal_rows: 'session_id epoch seq ts row_json',
  journal_outcome_generations: 'generation session_id epoch',
  journal_outcome_epochs: 'session_id epoch generation format through_seq prefix_seq',
  journal_outcomes: 'generation seq field entry_key format ordinal value_json deleted',
  queued_messages:
    'session_id message_id position body_json fingerprint created_at host_instance state hold_reason returned_reason returned_rejection settled_at settled_by_op consumed_as carried_from queued_epoch queued_sequence options_json'
}
const RECOVERY_TABLES = ['journal_repairs', 'journal_imports', 'journal_set_aside']
export type LegacyProofCursor = { table: number; after: string | null }
export type LegacySourceSession = {
  sessionId: string
  workspaceId: string
  epoch: string
  empty: boolean
}
export type LegacyProofPage = {
  next: LegacyProofCursor | null
  sessions: LegacySourceSession[]
  retained?: string
}

/** Every saved content row must belong to the current catalog before any source file can retire. */
export function readJournalLegacyProofPage(
  db: Database.Database,
  cursor: LegacyProofCursor,
  destination: Database.Database
): LegacyProofPage {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => String(row.name))
  )
  if (cursor.table === 0 && cursor.after === null) {
    const version = Number(db.pragma('user_version', { simple: true }))
    if (version !== 3 && version !== 4) {
      throw new JournalLegacyRetentionError('unsupported legacy source inventory')
    }
    for (const table of tables) {
      const names =
        PROFILE_TABLES.has(table) && table !== 'sqlite_sequence'
          ? destination
              .prepare(`PRAGMA table_info(${table})`)
              .all()
              .map((column) => column.name)
          : SOURCE_COLUMNS[table]?.split(' ')
      if (names) {
        const columns = new Set(names)
        if (
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((column) => !columns.has(column.name))
        ) {
          throw new JournalLegacyRetentionError('legacy source has unaccounted columns')
        }
      }

      if (
        PROFILE_TABLES.has(table) ||
        CONTENT_TABLES.includes(table as (typeof CONTENT_TABLES)[number]) ||
        table === 'journal_sessions'
      ) {
        continue
      }
      const quoted = `"${table.replaceAll('"', '""')}"`
      if (db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get()) {
        throw new JournalLegacyRetentionError('legacy source has unaccounted recovery data')
      }
      if (!RECOVERY_TABLES.includes(table)) {
        throw new JournalLegacyRetentionError('legacy source has an unknown table')
      }
    }
  }
  if (cursor.table > 0) {
    const table = CONTENT_TABLES[cursor.table - 1]!
    if (!tables.has(table)) {
      return {
        next:
          cursor.table < CONTENT_TABLES.length ? { table: cursor.table + 1, after: null } : null,
        sessions: []
      }
    }
    const columns =
      table === 'journal_outcomes'
        ? 'generation'
        : table === 'queued_messages'
          ? `session_id,${
              db
                .prepare('PRAGMA table_info(queued_messages)')
                .all()
                .some((column) => column.name === 'queued_epoch')
                ? 'queued_epoch'
                : 'NULL'
            } AS epoch`
          : table === 'journal_rows'
            ? 'session_id,epoch'
            : 'session_id,epoch,generation'
    const statement = db.prepare(
      `SELECT rowid AS rowid,${columns} FROM ${table} ${cursor.after === null ? '' : 'WHERE rowid>?'} ORDER BY rowid LIMIT 128`
    )
    statement.setReadBigInts(true)
    const rows = statement.all(...(cursor.after === null ? [] : [BigInt(cursor.after)]))
    for (const row of rows) {
      if (
        table === 'queued_messages' &&
        !readStoredQueuedMessageRow(
          db.prepare('SELECT * FROM queued_messages WHERE rowid=?').get(row.rowid!)
        )
      ) {
        throw new JournalLegacyRetentionError('legacy source has unreadable queued text')
      }

      const session =
        table === 'journal_outcomes'
          ? db
              .prepare(
                'SELECT session_id,epoch FROM journal_outcome_generations WHERE generation=?'
              )
              .get(row.generation!)
          : row
      if (table === 'journal_outcomes' && !session) {
        throw new JournalLegacyRetentionError('legacy source has an orphan outcome')
      }
      if (table === 'journal_outcomes' || table === 'journal_outcome_generations') {
        if (
          !db
            .prepare(
              'SELECT 1 FROM journal_outcome_epochs WHERE session_id=? AND epoch=? AND generation=?'
            )
            .get(session!.session_id!, session!.epoch!, row.generation!)
        ) {
          continue
        }
      }
      const matchEpoch = table !== 'queued_messages' || session?.epoch != null
      if (
        !session ||
        !db
          .prepare(
            `SELECT 1 FROM journal_sessions WHERE session_id=?${matchEpoch ? ' AND epoch=?' : ''}`
          )
          .get(session.session_id!, ...(matchEpoch ? [session.epoch!] : []))
      ) {
        throw new JournalLegacyRetentionError('legacy source has orphan content')
      }
    }
    return {
      next: rows.length
        ? { table: cursor.table, after: String(rows.at(-1)!.rowid) }
        : cursor.table < CONTENT_TABLES.length
          ? { table: cursor.table + 1, after: null }
          : null,
      sessions: []
    }
  }
  const rows = db
    .prepare(
      `SELECT session_id,workspace_id,epoch FROM journal_sessions ${cursor.after === null ? '' : 'WHERE session_id>?'} ORDER BY session_id LIMIT 32`
    )
    .all(...(cursor.after === null ? [] : [cursor.after]))
  const sessions = rows.map((row) => {
    const id = String(row.session_id)
    const hasRows = !!db.prepare('SELECT 1 FROM journal_rows WHERE session_id=? LIMIT 1').get(id)
    const hasQueue =
      tables.has('queued_messages') &&
      !!db.prepare('SELECT 1 FROM queued_messages WHERE session_id=? LIMIT 1').get(id)
    if (!hasRows && hasQueue) {
      throw new JournalLegacyRetentionError('legacy queued-only history still requires its source')
    }
    const empty =
      !hasRows &&
      !hasQueue &&
      (!tables.has('journal_outcome_epochs') ||
        !db.prepare('SELECT 1 FROM journal_outcome_epochs WHERE session_id=? LIMIT 1').get(id))
    return { sessionId: id, workspaceId: String(row.workspace_id), epoch: String(row.epoch), empty }
  })
  return {
    next: rows.length
      ? { table: 0, after: String(rows.at(-1)!.session_id) }
      : { table: 1, after: null },
    sessions
  }
}

export async function completeJournalLegacyProof(
  readers: Pick<JournalSqlReaderPool, 'legacyProof' | 'importState'>,
  conversions: Pick<JournalSqlConversions, 'ensure'>,
  writer: Pick<JournalSqlOwner, 'maintain'>,
  boundary: () => Promise<boolean>,
  signal: AbortSignal,
  rest: (started: number) => Promise<void>
): Promise<void> {
  let cursor: LegacyProofCursor | null = { table: 0, after: null }
  while (cursor && !signal.aborted) {
    if (!(await boundary())) {
      throw new Error('legacy proof was interrupted')
    }
    const started = performance.now()
    const page = await readers.legacyProof(cursor)
    await rest(started)
    if (page.retained) {
      throw new JournalLegacyRetentionError(page.retained)
    }
    for (const source of page.sessions) {
      try {
        await conversions.ensure(source.sessionId, false)
      } catch (error) {
        const refusal = journalOpenRefusal(error)
        if (
          refusal.code === 'agent_session_journal_unreadable' &&
          refusal.details?.reason !== 'journalUnavailable'
        ) {
          throw new JournalLegacyRetentionError(refusal.message)
        }
        throw error
      }
      if ((await readers.importState(source.sessionId)).state !== 'ready' && source.empty) {
        await writer.maintain({
          kind: 'import-finish',
          header: {
            sessionId: source.sessionId,
            workspaceId: source.workspaceId,
            epoch: source.epoch,
            head: {
              lastSequence: 0,
              highestFence: 0,
              contextBoundary: 0,
              lastActivityAt: 0,
              derivedTurnItemId: null,
              historyOrigin: null,
              queueFailureBoundary: 0,
              queuePauseMarks: { latestStop: null, resumedSequence: 0, reopenedSequence: 0 }
            }
          }
        })
      }
      if ((await readers.importState(source.sessionId)).state !== 'ready') {
        throw new JournalLegacyRetentionError(
          'legacy source still has unconverted or queued history'
        )
      }
    }
    cursor = page.next
  }
  if (signal.aborted) {
    throw new Error('legacy proof was interrupted')
  }
}
