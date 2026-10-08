// Opening the host's chat journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no persistent pragma and run
// no DDL: a database written by a newer schema must be left byte-identical, and
// `journal_mode = WAL` writes the file header.

import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql,
  JOURNAL_DB_OLDEST_RELEASED_VERSION,
  JOURNAL_DB_SCHEMA_VERSION
} from './journal-database-schema'
import { JournalUnreleasedSchemaError } from './journal-open-failure'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'
import { ensureAgentSessionOperationIndexes } from '../../runtime/agent-session-operation-sql'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000
/** Bounds the WAL a checkpoint leaves behind; SQLite truncates it back to this after a reset. */
export const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024
/** Every commit is fsynced before its caller continues. */
const JOURNAL_SYNCHRONOUS = 'FULL'

export type OpenJournalDatabase = {
  db: Database.Database
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

/** Whether the database holds any chat record or tab, read-only. */
export function journalDatabaseHoldsAgentSessions(dbPath: string): boolean {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name)
    )
    return ['agent_session_records', 'agent_session_tabs'].some(
      (table) =>
        tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
    )
  } finally {
    db.close()
  }
}

export function openJournalDatabase(dbPath: string): OpenJournalDatabase {
  const probe = new Database(dbPath)
  let stored: number
  try {
    stored = journalPragmaNumber(probe, 'user_version')
  } catch (error) {
    probe.close()
    throw error
  }
  if (stored > JOURNAL_DB_SCHEMA_VERSION) {
    probe.close()
    return {
      db: new Database(dbPath, { readonly: true, fileMustExist: true }),
      readOnly: true
    }
  }
  let transferred = false
  try {
    if (stored !== 0 && stored < JOURNAL_DB_OLDEST_RELEASED_VERSION) {
      // No retry reads past it, so every chat says it can't load; the log says what to do.
      throw new JournalUnreleasedSchemaError(
        `chat journal ${dbPath} uses unreleased schema ${stored}, written by an unreleased development build of Orca. Orca can't load its chats. Moving the file aside lets Orca start a new one, but that loses every chat's history, tabs and ownership records stored in it.`
      )
    }
    configureJournalPragmas(probe, stored)
    migrateJournalSchema(probe, stored)
    // Outside `migrateJournalSchema` on purpose: its early return skips a db
    // already at the current version, and this table must exist at EVERY
    // writable open with no `user_version` bump (see `ensureQueuedMessagesTable`).
    ensureQueuedMessagesTable(probe)
    ensureAgentSessionAttachmentClaimTables(probe)
    buildOperationIndexes(probe)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return { db: probe, readOnly: false }
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

/** Receipt indexes only speed lookups: a failed build warns and the next open retries it. */
function buildOperationIndexes(db: Database.Database): void {
  let stranded = false
  try {
    runJournalTransaction(
      db,
      () => ensureAgentSessionOperationIndexes(db),
      () => {
        stranded = true
      }
    )
  } catch (error) {
    // A connection still inside the failed transaction is unusable.
    if (stranded) {
      throw error
    }
    console.warn('[journal-open] operation receipt index build skipped:', error)
  }
}

function configureJournalPragmas(db: Database.Database, stored: number): void {
  if (stored === 0) {
    // Only takes on an empty file, and only before WAL, so it is set now: nothing reclaims pages
    // yet, but a later pass can free them in bounded steps rather than a full VACUUM.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // Why FULL rather than the house NORMAL: NORMAL in WAL mode does not fsync at commit, and the
  // write-ahead submission row must be on disk before the adapter dispatches anything. FULL alone
  // does not survive power loss on macOS, whose fsync leaves the drive cache unflushed; checkpoint
  // fullfsync makes each checkpoint use F_FULLFSYNC (a no-op elsewhere).
  db.pragma(`synchronous = ${JOURNAL_SYNCHRONOUS}`)
  db.pragma('checkpoint_fullfsync = ON')
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`)
}

/**
 * Table creation and the `user_version` bump are ONE transaction: creating the tables first left a
 * shaped database still reporting version 0, which an older build does not latch read-only.
 */
function migrateJournalSchema(db: Database.Database, stored: number): void {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return
  }
  runJournalTransaction(db, () => {
    if (stored === 0) {
      db.exec(createJournalTablesSql())
    }
    db.exec(createAgentSessionRecordTablesSql())
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
  })
}

/**
 * One IMMEDIATE transaction, its COMMIT inside the failure boundary: SQLite can leave a transaction
 * open after a failed COMMIT, and on the shared connection every later BEGIN would then fail. The
 * caller gets the original error; a ROLLBACK that fails too goes to `onStranded`. `run` is
 * synchronous by contract: an await inside it would let another chat's statements land in this
 * transaction.
 */
export function runJournalTransaction<T>(
  db: Database.Database,
  run: (db: Database.Database) => T,
  onStranded: () => void = () => undefined
): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run(db)
    if (result instanceof Promise) {
      throw new Error('a chat journal transaction must not await')
    }
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
      } catch (rollbackError) {
        console.warn(
          '[agent-session-journal] rolling back a failed transaction failed',
          rollbackError
        )
        onStranded()
      }
    }
    throw error
  }
}
