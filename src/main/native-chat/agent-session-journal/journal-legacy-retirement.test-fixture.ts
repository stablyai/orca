import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase, runJournalTransaction } from './database/journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './database/journal-domain-database'
import { journalDatabasePath } from './database/journal-host-database'
import { JournalSqlBatch } from './journal-sql-batch'
import { applyJournalSqlMaintenance, type JournalSqlMaintenance } from './journal-sql-maintenance'
import { readJournalLegacyProofPage } from './journal-legacy-source-proof'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { journalDomainImportState } from './journal-domain-import-rows'
import { prepareJournalDomainImport } from './journal-domain-import'
import { journalLegacyConversionSource } from './database/journal-legacy-source'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'

export const cleanup: (() => void)[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

const native = process.env.ORCA_JOURNAL_NATIVE_LOCK_TEST === '1'

/** Without the built helper, the same removal the helper performs once it holds the lock. */
export async function fakeLease(filename: string) {
  return {
    held: () => true,
    close: async () => {},
    retire: async () => {
      for (const name of [filename, `${filename}-wal`, `${filename}-shm`]) {
        if (existsSync(name)) {
          unlinkSync(name)
        }
      }
      return true
    }
  }
}

/** An older Orca's writable open of the original, adding one chat with saved history. */
export function olderOrcaChat(filename: string, sessionId: string): void {
  const { db } = openJournalDatabase(filename)
  runJournalTransaction(db, () => {
    publishJournalSessionEpoch(db, { sessionId, workspaceId: 'workspace' }, 'epoch')
    for (const row of journalSqlRetryRows(true)) {
      insertJournalRow(db, sessionId, row)
    }
    db.prepare('INSERT INTO agent_session_records VALUES(?,?)').run(
      sessionId,
      JSON.stringify({ sessionId, lease: { sessionId } })
    )
  })
  db.close()
}

/** An older Orca's later turns in a chat, as a new epoch replacing the old (as its /clear does). */
export function continueInOlderOrca(filename: string, sessionId: string): void {
  const { db } = openJournalDatabase(filename)
  runJournalTransaction(db, () => {
    db.prepare("DELETE FROM journal_rows WHERE session_id=? AND epoch<>'continued'").run(sessionId)
    publishJournalSessionEpoch(db, { sessionId, workspaceId: 'workspace' }, 'continued')
    for (const row of journalSqlRetryRows(true)) {
      insertJournalRow(db, sessionId, { ...row, epoch: 'continued' })
    }
  })
  db.close()
}

/** A profile an Orca at `copiedBy` copied, holding one unconverted chat with history. */
export async function profile(
  options: {
    copiedBy?: string
    seed?: (db: Database.Database) => void
    /** Converting this chat fails with this error, as a reader would. */
    failConversion?: { sessionId: string; error: Error }
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-retirement-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = journalDatabasePath(root)
  olderOrcaChat(filename, 'unopened')
  if (options.seed) {
    const { db: legacy } = openJournalDatabase(filename)
    options.seed(legacy)
    legacy.close()
  }
  vi.stubEnv('ORCA_APP_VERSION', options.copiedBy ?? '1.0.0')
  const domainFile = await initializeJournalDomainDatabase(root)
  const { db } = openJournalDomainDatabase(domainFile)
  cleanup.push(() => db.close())
  let original: Database.Database | undefined
  const source = () =>
    (original ??= new Database(filename, { readonly: true, fileMustExist: true }))
  cleanup.push(() => original?.close())
  const batch = new JournalSqlBatch(db)
  const writer = {
    maintain: async (operation: JournalSqlMaintenance) => {
      const result = await batch.run(
        [operation],
        (unit) => applyJournalSqlMaintenance(db, unit),
        operation.kind === 'legacy-retirement-save' && operation.durable ? 'retirement' : 'normal'
      )
      const outcome = result.outcomes[0]!
      if (!outcome.committed) {
        throw outcome.error
      }
      return outcome.value
    }
  }
  const readers = {
    // As the reader does: a refusal comes back as a page, not a thrown error.
    legacyProof: async (cursor) => {
      try {
        return readJournalLegacyProofPage(source(), cursor, db)
      } catch (error) {
        if (!(error instanceof JournalLegacyRetentionError)) {
          throw error
        }
        return {
          next: null,
          sessions: [],
          retained: error.message,
          reason: error.reason,
          artifact: error.artifact
        }
      }
    },
    importState: async (id) => journalDomainImportState(db, id),
    recycleSourceReaders: async (): Promise<AbortController | null> => {
      original?.close()
      original = undefined
      return new AbortController()
    },
    releaseSourceReaders: () => {}
  } satisfies Pick<
    JournalSqlReaderPool,
    'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
  >
  const ensured: string[] = []
  /** Converting a chat named here fails once with its error, as a lost reader would. */
  const failOnce = new Map<string, Error>()
  const conversions = {
    ensure: async (id: string) => {
      ensured.push(id)
      if (options.failConversion?.sessionId === id) {
        throw options.failConversion.error
      }
      const once = failOnce.get(id)
      if (once) {
        failOnce.delete(id)
        throw once
      }
      if (journalDomainImportState(db, id).state === 'ready') {
        return 'epoch'
      }
      // As the reader does: a copy takes its original chat's history under its own id.
      const from = journalLegacyConversionSource(db, id)
      const prepared = prepareJournalDomainImport(source(), from)
      if (!prepared) {
        return null
      }
      const { pages, ...header } = prepared
      const imported = from === id ? header : { ...header, sessionId: id, sourceRevision: null }
      for (const page of pages) {
        await writer.maintain({ kind: 'import-page', target: imported, page })
      }
      return String(await writer.maintain({ kind: 'import-finish', header: imported }))
    }
  }
  const errors: unknown[] = []
  /** A launch of the Orca at `version`, owning the profile unless told otherwise. */
  const launch = (
    version: string | null = '1.0.1',
    owns: boolean | (() => boolean) = true,
    lock = native ? acquireJournalLegacyFileLock : fakeLease,
    eligibility?: ConstructorParameters<typeof JournalLegacyRetirement>[9],
    // A build that deletes unless a test says otherwise: most of these test what the proof requires.
    deletes = true
  ) =>
    new JournalLegacyRetirement(
      root,
      writer,
      readers,
      conversions,
      async () => true,
      (error) => errors.push(error),
      typeof owns === 'function' ? owns : () => owns,
      lock,
      undefined,
      eligibility ?? (native ? undefined : { check: async () => {}, present: () => {} }),
      version,
      deletes
    )
  return {
    root,
    filename,
    db,
    launch,
    errors,
    source,
    readers,
    writer,
    convert: conversions.ensure,
    ensured,
    failOnce
  }
}
