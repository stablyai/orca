import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import Database from '../../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../../sqlite/harden-database-files'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  journalPragmaNumber,
  type OpenJournalDatabase
} from './journal-database'
import { JOURNAL_DB_OLDEST_RELEASED_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import { JournalUnreleasedSchemaError } from '../replay/journal-open-failure'
import {
  JOURNAL_DOMAIN_SCHEMA_VERSION,
  migrateJournalDomainSchema
} from './journal-domain-migrations'

export function journalDomainDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, 'agent-session-domain.db')
}

/** Run once on the writer worker, before opening its steady-state writable connection. */
export async function initializeJournalDomainDatabase(stateDirectory: string): Promise<string> {
  const destination = journalDomainDatabasePath(stateDirectory)
  if (existsSync(destination)) {
    return destination
  }
  mkdirSync(stateDirectory, { recursive: true })
  const temporary = mkdtempSync(join(stateDirectory, `.journal-domain-import-${process.pid}-`))
  try {
    const snapshot = join(temporary, 'snapshot.db')
    const sourcePath = journalDatabasePath(stateDirectory)
    const copied = existsSync(sourcePath)
    if (copied) {
      const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
      try {
        await source.backup(snapshot)
      } finally {
        source.close()
      }
    }
    prepareJournalDomainSnapshot(snapshot, copied)
    hardenSqliteDatabaseFiles(snapshot)
    try {
      // A hard link publishes the complete snapshot without replacing another initializer's result.
      linkSync(snapshot, destination)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
        throw error
      }
    }
    return destination
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

/** Only the private complete snapshot may pay for pointer-map creation and an offline VACUUM. */
function prepareJournalDomainSnapshot(filename: string, copied: boolean): void {
  const db = new Database(filename)
  try {
    if (journalPragmaNumber(db, 'user_version') > JOURNAL_DOMAIN_SCHEMA_VERSION) {
      return
    }
    db.pragma('journal_mode = DELETE')
    if (journalPragmaNumber(db, 'auto_vacuum') !== 2) {
      db.pragma('auto_vacuum = INCREMENTAL')
      if (copied) {
        db.exec('VACUUM')
      }
    }
  } finally {
    db.close()
  }
}

export function openJournalDomainDatabase(filename: string): OpenJournalDatabase {
  const db = new Database(filename)
  let transferred = false
  try {
    const stored = journalPragmaNumber(db, 'user_version')
    if (stored > JOURNAL_DOMAIN_SCHEMA_VERSION) {
      db.close()
      transferred = true
      return { db: new Database(filename, { readonly: true, fileMustExist: true }), readOnly: true }
    }
    if (stored !== 0 && stored < JOURNAL_DB_OLDEST_RELEASED_VERSION) {
      throw new JournalUnreleasedSchemaError(
        `chat journal ${filename} uses unreleased schema ${stored}, written by an unreleased development build of Orca. Orca can't load its chats. Moving the file aside lets Orca start a new one, but that loses every chat's history, tabs and ownership records stored in it.`
      )
    }
    if (stored === 0) {
      db.pragma('auto_vacuum = INCREMENTAL')
    }
    db.pragma(`busy_timeout = ${JOURNAL_BUSY_TIMEOUT_MS}`)
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('checkpoint_fullfsync = ON')
    db.pragma(`journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`)
    migrateJournalDomainSchema(db)
    hardenSqliteDatabaseFiles(filename)
    transferred = true
    return { db, readOnly: false }
  } finally {
    if (!transferred) {
      db.close()
    }
  }
}
