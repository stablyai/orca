import { ensurePRWatchTables } from '../../../github/pr-watch/pr-watch-tables'
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
import { journalDatabasePath } from './journal-host-database'
import {
  JOURNAL_DOMAIN_SCHEMA_VERSION,
  migrateJournalDomainSchema
} from './journal-domain-migrations'
import { importJournalDomainProfile } from './journal-domain-profile-import'
import {
  captureJournalLegacySourceReceipt,
  JOURNAL_LEGACY_SOURCE_RECEIPT
} from './journal-legacy-source-receipt'

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
    const sourceReceipt = captureJournalLegacySourceReceipt(sourcePath)
    try {
      if (existsSync(sourcePath)) {
        const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
        try {
          importJournalDomainProfile(source, db)
        } finally {
          source.close()
        }
      }
      db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
        JOURNAL_LEGACY_SOURCE_RECEIPT,
        JSON.stringify(sourceReceipt)
      )
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
        throw new Error('chat initialization could not fold its private WAL')
      }
    } finally {
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
    ensurePRWatchTables(db)
    hardenSqliteDatabaseFiles(filename)
    transferred = true
    return { db, readOnly: false }
  } finally {
    if (!transferred) {
      db.close()
    }
  }
}
