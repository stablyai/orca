// Opening the host's chat journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no persistent pragma and run
// no DDL: a database written by a newer schema must be left byte-identical, and
// `journal_mode = WAL` writes the file header.

import { existsSync } from 'node:fs'
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

export const JOURNAL_BUSY_TIMEOUT_MS = 5000
/** Bounds the WAL a checkpoint leaves behind; SQLite truncates it back to this after a reset. */
export const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024
/** Every commit but a first-use copy's batches, which no reader follows until a synced commit. */
export const JOURNAL_SYNCHRONOUS = 'FULL'

export type OpenJournalDatabase = {
  db: Database.Database
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
  /** The chat records file could not be read this launch: version 4's copy of it is still owed. */
  legacyRecordImportOwed: boolean
}

/**
 * What version 4's migration copies in from the chat records file that preceded it, read before
 * the open so no transaction waits on a file read. `owed` is a read that can clear: the tables are
 * made, and the copy and the version bump wait for a launch whose read succeeds.
 */
export type JournalLegacyRecordImport =
  | { owed: true }
  | { owed: false; write: (db: Database.Database) => void }

export const NO_LEGACY_JOURNAL_RECORDS: JournalLegacyRecordImport = {
  owed: false,
  write: () => undefined
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

/** Whether an open of a database at `stored` runs version 4's migration, and so reads the records
 *  file first. */
export function journalDatabaseMigratesRecords(stored: number): boolean {
  return (
    stored === 0 ||
    (stored >= JOURNAL_DB_OLDEST_RELEASED_VERSION && stored < JOURNAL_DB_SCHEMA_VERSION)
  )
}

/** 0 for a database not created yet: the probe never creates the file. */
export function readJournalDatabaseVersion(dbPath: string): number {
  if (!existsSync(dbPath)) {
    return 0
  }
  const probe = new Database(dbPath)
  try {
    return journalPragmaNumber(probe, 'user_version')
  } finally {
    probe.close()
  }
}

/**
 * Whether the database holds any chat record or tab, read-only. `undefined` while version 4's copy
 * of the records file is still owed, so the file answers for the chats it holds.
 */
export function journalDatabaseHoldsAgentSessions(dbPath: string): boolean | undefined {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const tables = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map(({ name }) => name)
    )
    const holds = ['agent_session_records', 'agent_session_tabs'].some(
      (table) =>
        tables.has(table) && db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get() !== undefined
    )
    if (holds || journalPragmaNumber(db, 'user_version') >= JOURNAL_DB_SCHEMA_VERSION) {
      return holds
    }
    return undefined
  } finally {
    db.close()
  }
}

export function openJournalDatabase(
  dbPath: string,
  legacyRecords: JournalLegacyRecordImport
): OpenJournalDatabase {
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
      readOnly: true,
      legacyRecordImportOwed: false
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
    const legacyRecordImportOwed = migrateJournalSchema(probe, stored, legacyRecords)
    // Outside `migrateJournalSchema` on purpose: its early return skips a db
    // already at the current version, and this table must exist at EVERY
    // writable open with no `user_version` bump (see `ensureQueuedMessagesTable`).
    ensureQueuedMessagesTable(probe)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return { db: probe, readOnly: false, legacyRecordImportOwed }
  } finally {
    if (!transferred) {
      probe.close()
    }
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
 * Table creation, the records copy and the `user_version` bump are ONE transaction. Creating the
 * tables first left a shaped database still reporting version 0, which an older build does not
 * latch read-only; and "copied" is `user_version >= 4`, so no other marker can disagree with it.
 * Returns whether the copy is still owed.
 */
function migrateJournalSchema(
  db: Database.Database,
  stored: number,
  legacyRecords: JournalLegacyRecordImport
): boolean {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return false
  }
  runJournalTransaction(db, () => {
    if (stored === 0) {
      db.exec(createJournalTablesSql())
    }
    db.exec(createAgentSessionRecordTablesSql())
    if (legacyRecords.owed) {
      // A fresh file still takes a released version, so an older build opens it as one.
      if (stored === 0) {
        db.pragma(`user_version = ${JOURNAL_DB_OLDEST_RELEASED_VERSION}`)
      }
      return
    }
    legacyRecords.write(db)
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
  })
  return legacyRecords.owed
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
