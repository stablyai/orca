import { mkdtempSync, rmSync } from 'node:fs'
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
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import { JournalLegacyRetirement } from './journal-legacy-retirement'

export const cleanup: (() => void)[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

export async function profile(
  seed?: (db: Database.Database) => void,
  eligibility?: ConstructorParameters<typeof JournalLegacyRetirement>[9]
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-retirement-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const filename = journalDatabasePath(root)
  const { db: legacy } = openJournalDatabase(filename)
  runJournalTransaction(legacy, () => {
    publishJournalSessionEpoch(
      legacy,
      { sessionId: 'unopened', workspaceId: 'folder-without-git' },
      'epoch'
    )
    for (const row of journalSqlRetryRows(true)) {
      insertJournalRow(legacy, 'unopened', row)
    }
  })
  seed?.(legacy)
  legacy.close()
  const { db } = openJournalDomainDatabase(await initializeJournalDomainDatabase(root))
  let closed = false
  const closeDomain = () => {
    if (!closed) {
      db.close()
      closed = true
    }
  }
  cleanup.push(closeDomain)
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
    legacyProof: async (cursor) => readJournalLegacyProofPage(source(), cursor, db),
    importState: async (id) => journalDomainImportState(db, id),
    recycleSourceReaders: async () => {
      original?.close()
      original = undefined
      return new AbortController()
    },
    releaseSourceReaders: () => {}
  } satisfies Pick<
    JournalSqlReaderPool,
    'legacyProof' | 'importState' | 'recycleSourceReaders' | 'releaseSourceReaders'
  >
  const conversions = {
    ensure: async (id: string) => {
      if (journalDomainImportState(db, id).state === 'ready') {
        return 'epoch'
      }
      const imported = prepareJournalDomainImport(source(), id)
      if (!imported) {
        return null
      }
      for (const page of imported.pages) {
        await writer.maintain({ kind: 'import-page', target: imported, page })
      }
      return String(await writer.maintain({ kind: 'import-finish', header: imported }))
    }
  }
  const errors: unknown[] = []
  const lock =
    process.env.ORCA_JOURNAL_NATIVE_LOCK_TEST === '1'
      ? acquireJournalLegacyFileLock
      : async () => ({ held: () => true, close: async () => {} })
  const reopen = () =>
    new JournalLegacyRetirement(
      root,
      writer,
      readers,
      conversions,
      async () => true,
      (error) => errors.push(error),
      () => true,
      lock,
      undefined,
      eligibility ??
        (process.env.ORCA_JOURNAL_NATIVE_LOCK_TEST === '1'
          ? undefined
          : { check: async () => {}, present: () => {} })
    )
  const retirement = reopen()
  const receiptState = () =>
    JSON.parse(
      String(
        db
          .prepare(
            "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v1'"
          )
          .get()!.value
      )
    )
  const saveState = (state: unknown) =>
    db
      .prepare(
        "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-retirement.v1'"
      )
      .run(JSON.stringify(state))
  const arm = () => {
    const row = db
      .prepare(
        "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v1'"
      )
      .get()
    const state = JSON.parse(String(row!.value))
    state.credit = 604800000
    state.process = 'prior-process'
    db.prepare(
      "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-retirement.v1'"
    ).run(JSON.stringify(state))
  }
  return {
    root,
    filename,
    db,
    retirement,
    reopen,
    conversions,
    errors,
    arm,
    source,
    receiptState,
    saveState,
    writer,
    closeDomain,
    readers,
    recycle: readers.recycleSourceReaders
  }
}
