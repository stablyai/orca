import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
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
import { importJournalDomainProfile } from './journal-domain-profile-import'

export function journalDomainDatabasePath(stateDirectory: string): string {
  return join(stateDirectory, 'agent-session-domain.db')
}

/** Run once on the writer worker, before opening its steady-state writable connection. */
export async function initializeJournalDomainDatabase(stateDirectory: string): Promise<string> {
  const destination = journalDomainDatabasePath(stateDirectory)
  mkdirSync(stateDirectory, { recursive: true })
  try {
    removeAbandonedInitializers(stateDirectory)
  } catch (error) {
    console.warn('[agent-session-journal] removing an abandoned initializer failed', error)
  }
  if (existsSync(destination)) {
    return destination
  }
  const temporary = mkdtempSync(join(stateDirectory, `.journal-domain-import-${process.pid}-`))
  try {
    const filename = join(temporary, 'snapshot.db')
    const { db } = openJournalDomainDatabase(filename)
    const sourcePath = journalDatabasePath(stateDirectory)
    try {
      if (existsSync(sourcePath)) {
        const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
        try {
          await importJournalDomainProfile(source, db)
        } finally {
          source.close()
        }
      }
    } finally {
      // Closing folds the private WAL into the file before it is published.
      db.close()
    }
    try {
      // Publish complete metadata without replacing another initializer's result.
      linkSync(filename, destination)
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

/** Only recognized dead-PID initializers are ours to discard; live and unknown owners stay. */
function removeAbandonedInitializers(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const match = /^\.journal-domain-import-([1-9][0-9]*)-[A-Za-z0-9]{6}$/.exec(entry.name)
    if (!entry.isDirectory() || !match) {
      continue
    }
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid > 2147483647) {
      continue
    }
    try {
      process.kill(pid, 0)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        rmSync(join(directory, entry.name), { recursive: true, force: true })
      }
    }
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
