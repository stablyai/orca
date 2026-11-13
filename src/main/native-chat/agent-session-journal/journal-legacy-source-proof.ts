import { JOURNAL_DOMAIN_PROFILE_TABLES } from './database/journal-domain-profile-columns'
import {
  JournalLegacyRetentionError,
  readJournalLegacySource,
  type LegacySourceRefusalReason
} from './journal-legacy-retention-error'
import { readStoredQueuedMessageRow } from './queued-messages/queued-message-stored-row'
import type Database from '../../sqlite/sync-database'

const PROFILE_TABLES = new Set([
  ...JOURNAL_DOMAIN_PROFILE_TABLES.map(({ name }) => name),
  'sqlite_sequence'
])
const CONTENT_TABLES: readonly string[] = [
  'journal_rows',
  'journal_outcome_generations',
  'journal_outcome_epochs',
  'journal_outcomes',
  'queued_messages'
]
const SOURCE_COLUMNS: Readonly<Record<string, string>> = {
  journal_sessions: 'session_id workspace_id epoch',
  journal_rows: 'session_id epoch seq ts row_json',
  journal_outcome_generations: 'generation session_id epoch',
  journal_outcome_epochs: 'session_id epoch generation format through_seq prefix_seq',
  journal_outcomes: 'generation seq field entry_key format ordinal value_json deleted',
  queued_messages:
    'session_id message_id position body_json fingerprint created_at host_instance state hold_reason returned_reason returned_rejection settled_at settled_by_op consumed_as carried_from queued_epoch queued_sequence options_json'
}
const PROFILE_COLUMNS = new Map(
  JOURNAL_DOMAIN_PROFILE_TABLES.map(({ name, columns }) => [name, new Set<unknown>(columns)])
)
const RECOVERY_TABLES = ['journal_repairs', 'journal_imports', 'journal_set_aside']
export type LegacyProofCursor = { table: number; after: string | null; epoch?: string }
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
  reason?: LegacySourceRefusalReason
}

/** Every saved content row must belong to the current catalog before any source file can retire. */
export function readJournalLegacyProofPage(
  db: Database.Database,
  cursor: LegacyProofCursor,
  destination: Database.Database
): LegacyProofPage {
  if (cursor.table === 0 && cursor.after === null) {
    for (const { name, columns } of JOURNAL_DOMAIN_PROFILE_TABLES) {
      const present = new Set(
        destination
          .prepare(`PRAGMA table_info(${name})`)
          .all()
          .map((column) => column.name)
      )
      if (columns.some((column) => !present.has(column))) {
        throw new Error(`legacy proof requires complete destination table ${name}`)
      }
    }
  }
  return readJournalLegacySource(() => readSourcePage(db, cursor))
}

function readSourcePage(db: Database.Database, cursor: LegacyProofCursor): LegacyProofPage {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => String(row.name))
  )
  if (cursor.table === 0 && cursor.after === null) {
    const version = Number(db.pragma('user_version', { simple: true }))
    if (version !== 3 && version !== 4) {
      throw new JournalLegacyRetentionError(
        'unsupported legacy source inventory',
        'source-inventory'
      )
    }
    for (const table of tables) {
      const columns =
        PROFILE_COLUMNS.get(table) ??
        (SOURCE_COLUMNS[table] ? new Set(SOURCE_COLUMNS[table]!.split(' ')) : undefined)
      if (columns) {
        if (
          db
            .prepare(`PRAGMA table_info(${table})`)
            .all()
            .some((column) => !columns.has(column.name))
        ) {
          throw new JournalLegacyRetentionError(
            'legacy source has unaccounted columns',
            'source-inventory'
          )
        }
      }

      if (
        PROFILE_TABLES.has(table) ||
        CONTENT_TABLES.includes(table) ||
        table === 'journal_sessions'
      ) {
        continue
      }
      const quoted = `"${table.replaceAll('"', '""')}"`
      if (db.prepare(`SELECT 1 FROM ${quoted} LIMIT 1`).get()) {
        throw new JournalLegacyRetentionError(
          'legacy source has unaccounted recovery data',
          'source-recovery'
        )
      }
      if (!RECOVERY_TABLES.includes(table)) {
        throw new JournalLegacyRetentionError(
          'legacy source has an unknown table',
          'source-inventory'
        )
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
    const indexed = table === 'journal_rows' || table === 'journal_outcomes'
    const statement = db.prepare(
      indexed
        ? table === 'journal_rows'
          ? `SELECT DISTINCT session_id,epoch FROM journal_rows ${cursor.after === null ? '' : 'WHERE (session_id,epoch)>(?,?)'} ORDER BY session_id,epoch LIMIT 128`
          : `SELECT DISTINCT generation FROM journal_outcomes ${cursor.after === null ? '' : 'WHERE generation>?'} ORDER BY generation LIMIT 128`
        : `SELECT rowid AS rowid,${columns} FROM ${table} ${cursor.after === null ? '' : 'WHERE rowid>?'} ORDER BY rowid LIMIT 128`
    )
    statement.setReadBigInts(true)
    const rows = statement.all(
      ...(cursor.after === null
        ? []
        : table === 'journal_rows'
          ? [cursor.after, cursor.epoch!]
          : [BigInt(cursor.after)])
    )
    for (const row of rows) {
      if (
        table === 'queued_messages' &&
        !readStoredQueuedMessageRow(
          db.prepare('SELECT * FROM queued_messages WHERE rowid=?').get(row.rowid!)
        )
      ) {
        throw new JournalLegacyRetentionError(
          'legacy source has unreadable queued text',
          'source-queue'
        )
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
        throw new JournalLegacyRetentionError(
          'legacy source has an orphan outcome',
          'source-orphan'
        )
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
        throw new JournalLegacyRetentionError('legacy source has orphan content', 'source-orphan')
      }
    }
    return {
      next: rows.length
        ? {
            table: cursor.table,
            after: String(
              table === 'journal_rows'
                ? rows.at(-1)!.session_id
                : table === 'journal_outcomes'
                  ? rows.at(-1)!.generation
                  : rows.at(-1)!.rowid
            ),
            ...(table === 'journal_rows' ? { epoch: String(rows.at(-1)!.epoch) } : {})
          }
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
      throw new JournalLegacyRetentionError(
        'legacy queued-only history still requires its source',
        'source-queued-only-v1'
      )
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
