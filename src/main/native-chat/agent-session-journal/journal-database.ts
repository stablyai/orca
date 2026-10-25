// Read user_version before persistent pragmas/DDL: even enabling WAL mutates newer databases.

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
import { ensureCommandReceiptsTable } from './command-receipt-schema'
import { ensureAgentSessionAttachmentClaimTables } from '../agent-session-attachments/agent-session-attachment-claims'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000
export const JOURNAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024
const JOURNAL_SYNCHRONOUS = 'FULL'

export type OpenJournalDatabase = {
  db: Database.Database
  readOnly: boolean
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

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
      throw new JournalUnreleasedSchemaError(
        `chat journal ${dbPath} uses unreleased schema ${stored}, written by an unreleased development build of Orca. Orca can't load its chats. Moving the file aside lets Orca start a new one, but that loses every chat's history, tabs and ownership records stored in it.`
      )
    }
    configureJournalPragmas(probe, stored)
    migrateJournalSchema(probe, stored)
    // Additive tables must exist on every writable open, even when version migration returns early.
    ensureQueuedMessagesTable(probe)
    ensureCommandReceiptsTable(probe)
    ensureAgentSessionAttachmentClaimTables(probe)
    hardenSqliteDatabaseFiles(dbPath)
    transferred = true
    return { db: probe, readOnly: false }
  } finally {
    if (!transferred) {
      probe.close()
    }
  }
}

function configureJournalPragmas(db: Database.Database, stored: number): void {
  if (stored === 0) {
    // INCREMENTAL must precede WAL/table creation to permit later bounded page reclamation.
    db.pragma('auto_vacuum = INCREMENTAL')
  }
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // FULL fsyncs submissions before dispatch; checkpoint_fullfsync also flushes macOS drive caches.
  db.pragma(`synchronous = ${JOURNAL_SYNCHRONOUS}`)
  db.pragma('checkpoint_fullfsync = ON')
  db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`)
}

/** Publish tables and user_version atomically so older clients cannot mistake a shaped database for v0. */
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

/** A fresh token for one attempt; a missing committed callback does not prove rollback. */
export type JournalTransactionObservation = {
  disposition: 'not-attempted' | 'unresolved' | 'not-committed' | 'committed'
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
  onStranded: () => void = () => undefined,
  observation?: JournalTransactionObservation
): T {
  if (observation) {
    observation.disposition = 'unresolved'
  }
  try {
    db.exec('BEGIN IMMEDIATE')
  } catch (error) {
    if (observation) {
      observation.disposition = 'not-committed'
    }
    throw error
  }
  try {
    const result = run(db)
    if (result instanceof Promise) {
      throw new Error('a chat journal transaction must not await')
    }
    db.exec('COMMIT')
    if (observation) {
      observation.disposition = 'committed'
    }
    return result
  } catch (error) {
    if (db.isTransaction) {
      try {
        db.exec('ROLLBACK')
        if (observation) {
          observation.disposition = 'not-committed'
        }
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
