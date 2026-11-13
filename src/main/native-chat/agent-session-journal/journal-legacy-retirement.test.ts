import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
  unlinkSync,
  statfsSync
} from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './database/journal-database'
import {
  initializeJournalDomainDatabase,
  openJournalDomainDatabase
} from './database/journal-domain-database'
import { journalLegacyFileIdentity } from './database/journal-legacy-source-receipt'
import { JournalSqlDatabase } from './database/journal-sql-database'
import {
  journalSqlWorkerPath,
  journalSqlReaderPath
} from './journal-sql-worker-bundle.test-fixture'
import { message } from './journal-sql-message.test-fixture'
import { journalDatabasePath } from './database/journal-host-database'
import { JournalSqlBatch } from './journal-sql-batch'
import { acquireJournalLegacyFileLock } from './journal-legacy-file-lock'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import {
  advanceLegacyRetirementClock,
  JournalLegacyGraceClock
} from './journal-legacy-retirement-state'
import { readJournalLegacyProofPage } from './journal-legacy-source-proof'
import { applyJournalSqlMaintenance, type JournalSqlMaintenance } from './journal-sql-maintenance'
import { runJournalTransaction } from './database/journal-database'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { journalDomainImportState } from './journal-domain-import-rows'
import { prepareJournalDomainImport } from './journal-domain-import'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

async function profile(seed?: (db: Database.Database) => void) {
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
  const retirement = new JournalLegacyRetirement(
    root,
    writer,
    readers,
    conversions,
    async () => true,
    (error) => errors.push(error),
    () => true,
    lock
  )
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
    errors,
    arm,
    source,
    receiptState,
    saveState,
    writer,
    closeDomain,
    recycle: readers.recycleSourceReaders
  }
}

it('accounts for an unopened folder chat, removes only the certified file and keeps current history', async () => {
  const test = await profile((legacy) => {
    legacy
      .prepare(
        `INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason,queued_epoch,queued_sequence)
         VALUES('unopened','saved-card',1,?,'f',1,'h','waiting','manual','epoch',1)`
      )
      .run(
        JSON.stringify({
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'saved queued text survives retirement' }]
        })
      )
  })
  const allocated = () => ({
    files: Object.fromEntries(
      readdirSync(test.root).map((name) => {
        const file = statSync(join(test.root, name))
        return [name, { logical: Number(file.size), allocated: Number(file.blocks) * 512 }]
      })
    ),
    freeBytes: Number(statfsSync(test.root).bfree) * Number(statfsSync(test.root).bsize)
  })
  const before = allocated()
  const proofStart = performance.now()
  await test.retirement.run()
  expect(test.errors).toEqual([])
  expect(existsSync(test.filename)).toBe(true)
  const proofMs = performance.now() - proofStart
  const proof = test.receiptState()
  test.saveState({ ...proof, credit: 604800000 })
  await test.retirement.run()
  expect(existsSync(test.filename)).toBe(true)
  test.arm()
  const deletionStart = performance.now()
  await test.retirement.run()
  expect(test.errors).toEqual([])
  expect(existsSync(test.filename)).toBe(false)
  expect(
    test.db
      .prepare(
        "SELECT payload_json FROM journal_items WHERE session_id='unopened' AND payload_json LIKE '%compact%' LIMIT 1"
      )
      .get()
  ).toBeDefined()
  expect(
    test.db
      .prepare(
        "SELECT payload_json FROM journal_queue_cards WHERE session_id='unopened' AND message_id='saved-card'"
      )
      .get()!.payload_json
  ).toContain('saved queued text survives retirement')
  await test.retirement.run()
  expect(existsSync(test.filename)).toBe(false)
  test.db.pragma('wal_checkpoint(TRUNCATE)')
  test.closeDomain()
  const after = allocated()
  const total = (files: typeof before.files) =>
    Object.values(files).reduce((sum, value) => sum + value.allocated, 0)
  console.info('synthetic allocated bytes after checkpoint and handle closure', {
    before,
    after,
    grossLegacyRemoved: before.files[basename(test.filename)]!.allocated,
    netRemoved: total(before.files) - total(after.files),
    proofMs,
    retireAndCheckpointMs: performance.now() - deletionStart
  })
  const options = {
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    onMaintenanceError: () => {}
  }
  const current = await JournalSqlDatabase.open(test.root, options)
  try {
    const { target } = await current.openSession({
      sessionId: 'new-current-chat',
      workspaceId: 'folder-without-git',
      hostId: 'synthetic-host',
      agent: 'codex',
      providerHandle: null
    })
    const step = message('saved after legacy retirement')
    await current.write({
      target,
      savedAt: 100,
      operation: {
        kind: 'steps',
        steps: [
          {
            kind: 'resolved-item',
            reservedBytes: 1024,
            resolution: { kind: 'text-snapshot', identity: step.identity, body: step.body },
            options: step.options
          }
        ]
      }
    })
  } finally {
    await current.close()
  }
  const reopened = await JournalSqlDatabase.open(test.root, options)
  try {
    expect(
      await reopened.readers.domainHistory({
        sessionId: 'new-current-chat',
        direction: 'after',
        limit: 10
      })
    ).toMatchObject({
      page: { items: [{ body: { blocks: [{ text: 'saved after legacy retirement' }] } }] }
    })
    expect(existsSync(test.filename)).toBe(false)
  } finally {
    await reopened.close()
  }
})

it('retains downgrade writes, a rollback journal and a nonempty WAL without changing their bytes', async () => {
  for (const kind of ['append', 'journal', 'wal'] as const) {
    const test = await profile()
    await test.retirement.run()
    test.arm()
    if (kind === 'append') {
      const old = new Database(test.filename)
      old
        .prepare('INSERT INTO journal_sessions VALUES(?,?,?)')
        .run('old-new-chat', 'folder', 'new-epoch')
      const savedItem = journalSqlRetryRows(true).find((row) => row.kind === 'item')!
      insertJournalRow(old, 'unopened', {
        ...savedItem,
        seq: journalSqlRetryRows(true).length + 1,
        itemId: 'downgraded-text',
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'saved by the downgraded build' }]
        }
      })
      insertJournalRow(old, 'old-new-chat', {
        ...journalSqlRetryRows(true)[0]!,
        epoch: 'new-epoch',
        seq: 1
      })
      old.close()
    } else {
      writeFileSync(test.filename + (kind === 'wal' ? '-wal' : '-journal'), 'owed recovery bytes')
    }
    const before = readFileSync(test.filename)
    await test.retirement.run()
    expect(existsSync(test.filename)).toBe(true)
    expect(readFileSync(test.filename)).toEqual(before)
    if (kind === 'append') {
      expect(
        test
          .source()
          .prepare("SELECT session_id FROM journal_sessions WHERE session_id='old-new-chat'")
          .get()
      ).toBeDefined()
      expect(
        test
          .source()
          .prepare(
            "SELECT row_json FROM journal_rows WHERE session_id='unopened' ORDER BY seq DESC LIMIT 1"
          )
          .get()!.row_json
      ).toContain('saved by the downgraded build')
    } else {
      expect(readFileSync(test.filename + (kind === 'wal' ? '-wal' : '-journal'), 'utf8')).toBe(
        'owed recovery bytes'
      )
    }
  }
})

it('does not earn grace from forward wall-clock steps and re-stamps a future completion', () => {
  const state = {
    version: 1 as const,
    proof: 'proof',
    proofId: 'id',
    completedAt: 100,
    process: 'prior',
    credit: 0,
    creditRevision: 0,
    lastWall: 100,
    phase: 'grace' as const
  }
  expect(advanceLegacyRetirementClock(state, 691200100, 3600000, 'next').credit).toBe(3600000)
  expect(
    advanceLegacyRetirementClock(
      { ...state, completedAt: 9000, credit: 604800000 },
      1000,
      10,
      'next'
    )
  ).toMatchObject({ completedAt: 1000, credit: 0, process: 'next' })

  let mono = 0n
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => mono)
  const clock = new JournalLegacyGraceClock()
  clock.persisted(state)
  mono = 3600000000000n
  expect(clock.observe(state, 691200100, 'next').credit).toBe(3600000)
  clock.pause()
  expect(clock.observe(state, 691200100, 'next').credit).toBe(3600000)
  const ambiguousCommit = { ...state, credit: 3600000, creditRevision: 1 }
  mono = 7200000000000n
  expect(clock.observe(ambiguousCommit, 691200100, 'next').credit).toBe(3600000)
})

it('retains queued-only text, recovery obligations and orphan history', async () => {
  for (const kind of ['queue', 'repair', 'orphan', 'extra-profile-column'] as const) {
    const test = await profile((legacy) => {
      if (kind === 'queue') {
        legacy.exec(
          'DELETE FROM journal_rows; INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason) VALUES(\'unopened\',\'held\',1,\'{"kind":"message","role":"user","blocks":[{"type":"text","text":"held user text"}]}\',\'f\',1,\'h\',\'waiting\',\'manual\')'
        )
      } else if (kind === 'repair') {
        legacy.exec("INSERT INTO journal_repairs VALUES('unopened','epoch',1,100)")
      } else if (kind === 'extra-profile-column') {
        legacy.exec(
          "ALTER TABLE agent_session_records ADD COLUMN future_text TEXT; INSERT INTO agent_session_records VALUES('unopened','{}','saved future field')"
        )
      } else {
        legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'orphan user text')")
      }
    })
    if (kind === 'queue') {
      const current = await JournalSqlDatabase.open(test.root, {
        writerPath: journalSqlWorkerPath(),
        readerPath: journalSqlReaderPath(),
        onMaintenanceError: () => {}
      })
      try {
        await current.openSession({
          sessionId: 'unopened',
          workspaceId: 'folder-without-git',
          hostId: 'synthetic-host',
          agent: 'codex',
          providerHandle: null
        })
      } finally {
        await current.close()
      }
    }
    const before = readFileSync(test.filename)
    await test.retirement.run()
    expect(test.errors.length).toBeGreaterThan(0)
    expect(readFileSync(test.filename)).toEqual(before)
    if (kind === 'queue') {
      expect(test.source().prepare('SELECT body_json FROM queued_messages').get()).toEqual({
        body_json:
          '{"kind":"message","role":"user","blocks":[{"type":"text","text":"held user text"}]}'
      })
    }
  }
})

it('resumes only the prepared empty companions and preserves a recreated main', async () => {
  for (const recreate of [false, true]) {
    const test = await profile()
    await test.retirement.run()
    await test.recycle()
    const shm = `${test.filename}-shm`
    writeFileSync(shm, 'derived index')
    const state = {
      ...test.receiptState(),
      phase: 'prepared',
      manifest: {
        '-shm': journalLegacyFileIdentity(shm),
        ...(existsSync(`${test.filename}-wal`)
          ? { '-wal': journalLegacyFileIdentity(`${test.filename}-wal`) }
          : {})
      }
    }
    test.saveState(state)
    unlinkSync(test.filename)
    if (recreate) {
      writeFileSync(test.filename, 'new old-build history')
    }
    await test.retirement.run()
    if (recreate) {
      expect(readFileSync(shm, 'utf8')).toBe('derived index')
    }
    if (recreate) {
      expect(readFileSync(test.filename, 'utf8')).toBe('new old-build history')
    } else {
      expect(test.errors).toEqual([])
      expect(existsSync(shm)).toBe(false)
    }
  }
})
