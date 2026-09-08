// Opening one session's journal database.
//
// `PRAGMA user_version` is read FIRST, on a connection that has set no
// persistent pragma and run no DDL: a future-schema database must be left
// byte-identical, and `journal_mode = WAL` writes the file header.

import { existsSync } from 'node:fs'
import Database from '../../sqlite/sync-database'
import { parseJournalRow } from './journal-row-schema'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { createJournalTablesSql, JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'

export const JOURNAL_BUSY_TIMEOUT_MS = 5000

export type OpenJournalDatabase = {
  db: Database.Database
  /** A newer `user_version` was met: this build reads and never writes. */
  readOnly: boolean
}

export function journalPragmaNumber(db: Database.Database, name: string): number {
  return Number(db.pragma(name, { simple: true }) ?? 0)
}

export function openJournalDatabase(dbPath: string): OpenJournalDatabase {
  const probe = new Database(dbPath, { readonly: existsSync(dbPath) })
  let stored: number
  try {
    stored = journalPragmaNumber(probe, 'user_version')
    if (stored <= JOURNAL_DB_SCHEMA_VERSION && hasFutureJournalRows(probe)) {
      probe.close()
      return { db: new Database(dbPath, { readonly: true, fileMustExist: true }), readOnly: true }
    }
  } catch (error) {
    probe.close()
    throw error
  }
  if (stored > JOURNAL_DB_SCHEMA_VERSION) {
    probe.close()
    return { db: new Database(dbPath, { readonly: true, fileMustExist: true }), readOnly: true }
  }
  probe.close()
  const writable = new Database(dbPath)
  let transferred = false
  try {
    configureJournalPragmas(writable)
    createJournalSchema(writable, stored)
    hardenSqliteDatabaseFiles(dbPath)
    const opened = { db: writable, readOnly: false }
    transferred = true
    return opened
  } finally {
    if (!transferred) {
      writable.close()
    }
  }
}

function configureJournalPragmas(db: Database.Database): void {
  db.pragma('journal_mode = WAL')
  db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
  db.pragma('foreign_keys = ON')
  // Why FULL rather than the house NORMAL: the write-ahead submission row must
  // survive a power loss before the adapter dispatches anything, and NORMAL in
  // WAL mode does not fsync at commit.
  db.pragma('synchronous = FULL')
}

/**
 * Table creation and the `user_version` bump are ONE transaction. Creating the
 * tables first left a shaped database still reporting version 0, which an older
 * build does not latch read-only: it stamped its own version on and wrote
 * through SQL for a schema it did not have.
 */
function createJournalSchema(db: Database.Database, stored: number): void {
  if (stored >= JOURNAL_DB_SCHEMA_VERSION) {
    return
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(createJournalTablesSql())
    db.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Check before persistent pragmas or migration, including rows behind a corrupt prefix. */
function hasFutureJournalRows(db: Database.Database): boolean {
  if (
    !db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'")
      .get()
  ) {
    return false
  }
  for (const entry of db.prepare('SELECT row_json FROM journal_rows').iterate()) {
    const parsed = parseJournalRow(entry.row_json)
    if (!parsed.ok && parsed.unreadable) {
      return true
    }
  }
  return false
}
