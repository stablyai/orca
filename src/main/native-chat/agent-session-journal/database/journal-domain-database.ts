import { ensurePRWatchTables } from '../../../github/pr-watch/pr-watch-tables'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as yieldToWorker } from 'node:timers/promises'
import Database from '../../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../../sqlite/harden-database-files'
import {
  JOURNAL_BUSY_TIMEOUT_MS,
  JOURNAL_SIZE_LIMIT_BYTES,
  journalPragmaNumber,
  type OpenJournalDatabase
} from './journal-database'
import {
  JOURNAL_LEGACY_CONVERTED_BY,
  journalDatabasePath,
  journalDomainDatabasePath,
  journalRunningOrcaVersion
} from './journal-host-database'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { tryFoldJournalTextTails } from '../journal-text-tail'
import {
  JOURNAL_DOMAIN_SCHEMA_VERSION,
  migrateJournalDomainSchema
} from './journal-domain-migrations'
import { importJournalDomainProfile } from './journal-domain-profile-import'
import { openJournalLegacySourceChecked } from './journal-legacy-source'
import {
  JOURNAL_LEGACY_REVISIONS_KEPT,
  reconcileJournalLegacySource
} from './journal-legacy-reconcile'
import {
  JOURNAL_LEGACY_SOURCE_RECEIPT,
  sameJournalLegacySource
} from './journal-legacy-source-receipt'
import { captureJournalLegacySourceReceipt } from './journal-legacy-source-capture'
import {
  assertJournalLegacyRecordFilesStable,
  createJournalLegacyRecordStage,
  readJournalLegacyRecordSnapshot,
  type JournalLegacyRecordSnapshot
} from './journal-legacy-record-file'
import { importJournalLegacyRecordSnapshot } from './journal-legacy-record-import'

/** Run once on the writer worker, before opening its steady-state writable connection. */
export async function initializeJournalDomainDatabase(
  stateDirectory: string,
  hostId: string = LOCAL_EXECUTION_HOST_ID,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  const destination = journalDomainDatabasePath(stateDirectory)
  mkdirSync(stateDirectory, { recursive: true })
  try {
    removeAbandonedInitializers(stateDirectory)
  } catch (error) {
    console.warn('[agent-session-journal] removing an abandoned initializer failed', error)
  }
  if (existsSync(destination)) {
    absorbOlderOrcaWrites(stateDirectory, destination)
    return destination
  }
  const temporary = mkdtempSync(join(stateDirectory, `.journal-domain-import-${process.pid}-`))
  try {
    const filename = join(temporary, 'snapshot.db')
    const { db } = openJournalDomainDatabase(filename)
    const sourcePath = journalDatabasePath(stateDirectory)
    const sourceReceipt = captureJournalLegacySourceReceipt(sourcePath)
    const savedReceipt = JSON.stringify(sourceReceipt)
    let recordFiles: JournalLegacyRecordSnapshot['files'] | undefined
    const assertStable = (): void => {
      if (!recordFiles) {
        return
      }
      if (!sameJournalLegacySource(savedReceipt, captureJournalLegacySourceReceipt(sourcePath))) {
        throw new Error('the original chat journal changed during initialization')
      }
      assertJournalLegacyRecordFilesStable(recordFiles)
    }
    try {
      if (existsSync(sourcePath)) {
        const { source, recordFileSource } = openJournalLegacySourceChecked(sourcePath, {
          inspectRecordFileSource: true
        })
        try {
          importJournalDomainProfile(source, db, { restoreRecordFile: recordFileSource })
          if (recordFileSource) {
            const stage = new Database(join(temporary, 'records-stage.db'))
            try {
              createJournalLegacyRecordStage(stage)
              const recordSnapshot = await readJournalLegacyRecordSnapshot(
                stateDirectory,
                stage,
                signal
              )
              recordFiles = recordSnapshot.files
              assertStable()
              importJournalLegacyRecordSnapshot(source, db, stage, recordSnapshot, hostId)
            } finally {
              stage.close()
            }
          }
        } finally {
          source.close()
        }
      }
      const meta = db.prepare(
        'INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)'
      )
      meta.run(JOURNAL_LEGACY_SOURCE_RECEIPT, savedReceipt)
      meta.run(JOURNAL_LEGACY_REVISIONS_KEPT, '1')
      // An unknown version is no later than any, and waits for a launch that knows its own.
      meta.run(JOURNAL_LEGACY_CONVERTED_BY, journalRunningOrcaVersion() ?? 'unknown')
      assertStable()
      const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
      if (checkpoint?.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
        throw new Error('chat initialization could not fold its private WAL')
      }
    } finally {
      db.close()
    }
    if (recordFiles && signal) {
      // Let a close received during the synchronous merge cancel before publication.
      await yieldToWorker()
      signal.throwIfAborted()
    }
    try {
      // Publish complete metadata without replacing another initializer's result.
      assertStable()
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

/** Best effort: a failure leaves the original unabsorbed for the next launch, never blocks chats. */
function absorbOlderOrcaWrites(stateDirectory: string, destination: string): void {
  try {
    const { db, readOnly } = openJournalDomainDatabase(destination)
    try {
      if (!readOnly) {
        reconcileJournalLegacySource(stateDirectory, db)
      }
    } finally {
      db.close()
    }
  } catch (error) {
    console.warn('[agent-session-journal] reading chats an older Orca saved failed', error)
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
    // Before any chat opens or reader starts, so recovery settles the whole saved text.
    tryFoldJournalTextTails(db)
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
