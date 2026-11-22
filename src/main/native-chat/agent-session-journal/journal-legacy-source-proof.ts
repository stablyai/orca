import { JOURNAL_DOMAIN_PROFILE_TABLES } from './database/journal-domain-profile-columns'
import {
  JournalLegacyRetentionError,
  legacyInventoryRefusal,
  legacyRecoveryRefusal,
  readJournalLegacySource,
  type LegacySourceArtifact,
  type LegacySourceRefusalReason
} from './journal-legacy-retention-error'
import { legacySourceArtifacts } from './journal-legacy-source-artifacts'
import { isRetiredSourceTable, legacySourceColumnsAccounted } from './journal-legacy-source-columns'
import { readStoredQueuedMessageRow } from './queued-messages/queued-message-stored-row'
import {
  readLegacyClaimsPage,
  readLegacyProofSessions,
  type LegacyClaim,
  type LegacySessionHold
} from './journal-legacy-content-proof'
import { LEGACY_PROOF_COPIES_TABLE } from './journal-legacy-retirement-state'
import { assertLegacyStoreReady, readLegacyCopiesProofPage } from './journal-legacy-proof-copies'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

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
const RECOVERY_TABLES = ['journal_repairs', 'journal_imports', 'journal_set_aside']
const COPIES = LEGACY_PROOF_COPIES_TABLE
if (COPIES !== CONTENT_TABLES.length + 2) {
  throw new Error('legacy proof copies follow the content tables and the claims')
}
/** `check`: the first page this launch reads, resumed past the start, checks compares due again. */
export type LegacyProofCursor = {
  table: number
  after: string | null
  epoch?: string
  check?: true
}
export type LegacySourceSession = {
  sessionId: string
  workspaceId: string
  epoch: string
  empty: boolean
} & LegacySessionHold
export type LegacyProofPage = {
  next: LegacyProofCursor | null
  sessions: LegacySourceSession[]
  retained?: string
  reason?: LegacySourceRefusalReason
  artifact?: JournalLegacyRetentionError['artifact']
  /** On the first page: the original carries a shape earlier builds refuse (see the layouts). */
  historical?: true
  /** Claims only the original holds, for chats kept here, taken in before it retires. */
  claims?: LegacyClaim[]
  /** Copies of chats an older Orca continued, converted from the original before it retires. */
  copies?: string[]
}

/** Every saved content row must belong to the current catalog before any source file can retire. */
export function readJournalLegacyProofPage(
  db: Database.Database,
  cursor: LegacyProofCursor,
  destination: Database.Database
): LegacyProofPage {
  // The first page this launch reads checks the store; a resumed one, its compares due again.
  if (cursor.check || (cursor.table === 0 && cursor.after === null)) {
    assertLegacyStoreReady(db, destination, !cursor.check)
  }
  return readJournalLegacySource(() => {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
        .all()
        .map((row) => String(row.name))
    )
    const artifact =
      cursor.table === 0 && cursor.after === null ? assertSourceInventory(db, tables) : 'none'
    const page = readSourcePage(db, cursor, destination, tables)
    return artifact === 'none' ? page : { ...page, historical: true }
  })
}

/** The original's tables and columns are ones some build wrote; returns the leftover shapes it has. */
function assertSourceInventory(
  db: Database.Database,
  tables: ReadonlySet<string>
): LegacySourceArtifact {
  const version = Number(db.pragma('user_version', { simple: true }))
  if (version !== 3 && version !== 4) {
    throw new JournalLegacyRetentionError(
      'unsupported legacy source inventory',
      'source-inventory'
    )
  }
  const artifact = legacySourceArtifacts(db, tables)
  for (const table of tables) {
    const quoted = `"${table.replaceAll('"', '""')}"`
    // Generated columns hold nothing of their own; a retired table is accepted only exactly.
    const present = db
      .prepare(`PRAGMA table_xinfo(${quoted})`)
      .all()
      .filter((column) => Number(column.hidden) === 0 || isRetiredSourceTable(table))
      .map((column) => String(column.name))
    if (!legacySourceColumnsAccounted(table, present)) {
      throw legacyInventoryRefusal(present, artifact)
    }

    if (
      PROFILE_TABLES.has(table) ||
      CONTENT_TABLES.includes(table) ||
      isRetiredSourceTable(table) ||
      table === 'journal_sessions'
    ) {
      continue
    }
    // Per-chat import markers (#23613) were left behind when #26038 removed those imports. One
    // whose rows all landed in journal_rows, or whose epoch a later /clear replaced (its rows
    // were discarded then), records nothing the journal still holds.
    const unaccounted =
      table === 'journal_imports'
        ? `SELECT 1 FROM journal_imports i
            WHERE EXISTS (SELECT 1 FROM journal_sessions s
              WHERE s.session_id=i.session_id AND s.epoch=i.epoch)
            AND NOT EXISTS (SELECT 1 FROM journal_rows r
              WHERE r.session_id=i.session_id AND r.epoch=i.epoch AND r.seq>=i.tip) LIMIT 1`
        : `SELECT 1 FROM ${quoted} LIMIT 1`
    if (db.prepare(unaccounted).get()) {
      throw legacyRecoveryRefusal(artifact)
    }
    if (!RECOVERY_TABLES.includes(table)) {
      // Empty too: an older build's table left behind still marks which builds wrote this file.
      throw legacyInventoryRefusal([], artifact)
    }
  }
  return artifact
}

function readSourcePage(
  db: Database.Database,
  cursor: LegacyProofCursor,
  destination: Database.Database,
  tables: ReadonlySet<string>
): LegacyProofPage {
  // Last, the copies the reconcile kept: converted from the original, then none may remain.
  if (cursor.table >= COPIES) {
    return readLegacyCopiesProofPage(db, destination, cursor, COPIES)
  }
  // After the content tables: the original's attachment claims, taken in for chats kept here.
  if (cursor.table > CONTENT_TABLES.length) {
    if (!tables.has('agent_session_attachment_claims')) {
      return { next: { table: COPIES, after: null }, sessions: [] }
    }
    const page = readLegacyClaimsPage(
      db,
      destination,
      cursor.after === null ? null : [cursor.after, cursor.epoch!]
    )
    return {
      next: page.last
        ? { table: cursor.table, after: page.last[0], epoch: page.last[1] }
        : { table: COPIES, after: null },
      sessions: [],
      claims: page.claims
    }
  }
  if (cursor.table > 0) {
    const table = CONTENT_TABLES[cursor.table - 1]!
    if (!tables.has(table)) {
      return {
        next: { table: cursor.table + 1, after: null },
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
    let rows: SqliteRow[]
    if (indexed) {
      // One seek per distinct key: a DISTINCT over the index would read every row of a huge chat
      // inside a single statement, which no pause between pages can interrupt.
      const keys = table === 'journal_rows' ? 'session_id,epoch' : 'generation'
      // The first page starts from the smallest key, whatever it is; later ones seek past the last.
      const first = db.prepare(`SELECT ${keys} FROM ${table} ORDER BY ${keys} LIMIT 1`)
      // A key range over (session_id,epoch) would step through every seq of the previous key, so
      // the next epoch of the same chat and the next chat are each one seek.
      const next = db.prepare(
        table === 'journal_rows'
          ? 'SELECT session_id,epoch FROM journal_rows WHERE session_id=? AND epoch>? ORDER BY epoch LIMIT 1'
          : 'SELECT generation FROM journal_outcomes WHERE generation>? ORDER BY generation LIMIT 1'
      )
      const nextChat = db.prepare(
        'SELECT session_id,epoch FROM journal_rows WHERE session_id>? ORDER BY session_id,epoch LIMIT 1'
      )
      first.setReadBigInts(true)
      next.setReadBigInts(true)
      nextChat.setReadBigInts(true)
      rows = []
      let after: SqliteRow[string][] | null =
        cursor.after === null
          ? null
          : table === 'journal_rows'
            ? [cursor.after, cursor.epoch!]
            : [BigInt(cursor.after)]
      while (rows.length < 128) {
        const row =
          after === null
            ? first.get()
            : (next.get(...after) ??
              (table === 'journal_rows' ? nextChat.get(after[0]!) : undefined))
        if (!row) {
          break
        }
        rows.push(row)
        after = table === 'journal_rows' ? [row.session_id, row.epoch] : [row.generation]
      }
    } else {
      const statement = db.prepare(
        `SELECT rowid AS rowid,${columns} FROM ${table} ${cursor.after === null ? '' : 'WHERE rowid>?'} ORDER BY rowid LIMIT 128`
      )
      statement.setReadBigInts(true)
      rows = statement.all(...(cursor.after === null ? [] : [BigInt(cursor.after)]))
    }
    // The retired sender column is never decoded, so its bytes aren't read here.
    const queued =
      table === 'queued_messages'
        ? db.prepare(
            `SELECT ${db
              .prepare('PRAGMA table_info(queued_messages)')
              .all()
              .map((column) => String(column.name))
              .filter((name) => name !== 'source_json')
              .map((name) => `"${name.replaceAll('"', '""')}"`)
              .join(',')} FROM queued_messages WHERE rowid=?`
          )
        : undefined
    for (const row of rows) {
      if (queued && !readStoredQueuedMessageRow(queued.get(row.rowid!))) {
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
        : { table: cursor.table + 1, after: null },
      sessions: []
    }
  }
  const rows = readLegacyProofSessions(db, destination, tables, cursor.after)
  return {
    next: rows.length ? { table: 0, after: rows.at(-1)!.sessionId } : { table: 1, after: null },
    sessions: rows
  }
}
