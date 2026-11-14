import { readFileSync, statSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import { JournalSqlConversions } from './journal-sql-conversions'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { insertJournalRow } from './durable-rows/journal-row-table'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { profile } from './journal-legacy-retirement.test-fixture'

function stored(test: Awaited<ReturnType<typeof profile>>, key = 'journal.legacy-retirement.v1') {
  return test.db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)?.value
}

it.each([
  ['missing', false],
  ['incomplete', false],
  ['missing', true],
  ['incomplete', true]
])('recovers %s destination inventory at the same inode (reopen=%s)', async (damage, reopen) => {
  const test = await profile()
  const bytes = readFileSync(test.filename)
  const receipt = stored(test, 'journal.legacy-source-copy.v1')
  const path = journalDomainDatabasePath(test.root)
  const { dev, ino } = statSync(path)
  const schema = String(
    test.db.prepare("SELECT sql FROM sqlite_schema WHERE name='agent_session_tabs'").get()!.sql
  )
  expect(test.db.prepare('SELECT COUNT(*) AS n FROM agent_session_tabs').get()!.n).toBe(0)
  expect(test.source().prepare('SELECT COUNT(*) AS n FROM agent_session_tabs').get()!.n).toBe(0)
  test.db.exec('DROP TABLE agent_session_tabs')
  if (damage === 'incomplete') {
    test.db.exec(
      'CREATE TABLE agent_session_tabs(tab_id TEXT PRIMARY KEY,session_id TEXT NOT NULL)'
    )
  }
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const proof = vi.spyOn(test.readers, 'legacyProof')
  const ensure = vi.spyOn(test.conversions, 'ensure')
  for (let attempt = 0; attempt < 2; attempt++) {
    await test.retirement.run()
    expect(stored(test)).toBeUndefined()
    expect(readFileSync(test.filename)).toEqual(bytes)
    expect(ensure).not.toHaveBeenCalled()
    now += 3600001
  }
  expect(proof).toHaveBeenCalledTimes(2)
  if (damage === 'incomplete') {
    test.db.exec('DROP TABLE agent_session_tabs')
  }
  test.db.exec(schema)
  expect(statSync(path)).toMatchObject({ dev, ino })
  if (reopen) {
    test.retirement.stop()
    await test.retirement.flushCredit()
  }
  expect(stored(test)).toBeUndefined()
  await (reopen ? test.reopen() : test.retirement).run()
  expect(test.receiptState().phase).toBe('grace')
  expect(stored(test, 'journal.legacy-source-copy.v1')).toBe(receipt)
  expect(readFileSync(test.filename)).toEqual(bytes)
})

it('reproves policy-1 false inventory and persists only genuine fixed-contract source columns under policy 2', async () => {
  const healthy = await profile()
  const receipt = stored(healthy, 'journal.legacy-source-copy.v1')
  const { dev, ino } = statSync(journalDomainDatabasePath(healthy.root), { bigint: true })
  await healthy.writer.maintain({
    kind: 'legacy-retirement-save',
    durable: false,
    value: JSON.stringify({
      version: 1,
      phase: 'refused',
      policy: 1,
      proof: receipt,
      observed: receipt,
      destination: `${dev}:${ino}`,
      reason: 'source-inventory'
    })
  })
  const oldProof = vi.spyOn(healthy.readers, 'legacyProof')
  await healthy.retirement.run()
  expect(oldProof.mock.calls.length).toBeGreaterThan(0)
  expect(healthy.receiptState().phase).toBe('grace')

  const check = vi.fn(async () => {})
  const extra = await profile(
    (source) => source.exec('ALTER TABLE agent_session_tabs ADD COLUMN future_text TEXT'),
    { present: () => {}, check }
  )
  const bytes = readFileSync(extra.filename)
  await extra.retirement.run()
  expect(extra.receiptState()).toMatchObject({
    phase: 'refused',
    policy: 2,
    reason: 'source-inventory'
  })
  const proof = vi.spyOn(extra.readers, 'legacyProof')
  const ensure = vi.spyOn(extra.conversions, 'ensure')
  check.mockClear()
  await extra.reopen().run()
  expect(proof).not.toHaveBeenCalled()
  expect(ensure).not.toHaveBeenCalled()
  expect(check).not.toHaveBeenCalled()
  expect(readFileSync(extra.filename)).toEqual(bytes)
})

it.each([1, 10])(
  'completes verified empty heads after ensure failure with bounded work over %s retries',
  async (retries) => {
    const test = await profile((source) => {
      source.exec(
        "INSERT INTO journal_sessions VALUES('a-completed','folder','empty'); DELETE FROM journal_rows WHERE session_id='unopened'"
      )
    })
    const bytes = readFileSync(test.filename)
    const readers = new JournalSqlReaderPool(
      journalDomainDatabasePath(test.root),
      test.filename,
      journalSqlReaderPath()
    )
    const background = new JournalSqlConversions(test.writer, readers, async () => {})
    const restored = vi.spyOn(readers, 'prepareConversion')
    const ensure = vi.spyOn(test.conversions, 'ensure').mockImplementation(async (id) => {
      if (id === 'unopened') {
        throw new Error('recoverable ensure dependency')
      }
      return background.ensure(id, false)
    })
    const maintain = test.writer.maintain.bind(test.writer)
    let failing = true
    const finish = vi.spyOn(test.writer, 'maintain').mockImplementation(async (op) => {
      if (op.kind === 'import-finish' && op.header.sessionId === 'unopened' && failing) {
        throw new Error('recoverable completion dependency')
      }
      return maintain(op)
    })
    const proof = vi.spyOn(test.readers, 'legacyProof')
    const state = vi.spyOn(test.readers, 'importState')
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      await test.retirement.run()
      const prefix = proof.mock.calls.length
      const attempts = ensure.mock.calls.length
      // The ordinary conversion owner really returns null and publishes no empty head.
      expect(await background.ensure('unopened', false)).toBeNull()
      const restoreCalls = restored.mock.calls.length
      expect(await test.readers.importState('unopened')).toEqual({
        state: 'converting',
        epoch: null
      })
      finish.mockClear()
      state.mockClear()
      for (let n = 0; n < retries; n++) {
        now += 3600001
        await test.retirement.run()
      }
      expect(ensure).toHaveBeenCalledTimes(attempts)
      expect(proof).toHaveBeenCalledTimes(prefix)
      expect(restored).toHaveBeenCalledTimes(restoreCalls)
      expect(state.mock.calls).toEqual(Array.from({ length: retries }, () => ['unopened']))
      expect(finish.mock.calls.filter(([op]) => op.kind === 'import-finish')).toHaveLength(retries)
      expect(stored(test)).toBeUndefined()
      failing = false
      finish.mockClear()
      now += 3600001
      await test.retirement.run()
      expect(test.receiptState().phase).toBe('grace')
      expect(finish.mock.calls.filter(([op]) => op.kind === 'import-finish')).toHaveLength(1)
      expect(ensure).toHaveBeenCalledTimes(attempts)
      expect(await test.readers.importState('unopened')).toEqual({ state: 'ready', epoch: 'epoch' })
      expect(readFileSync(test.filename)).toEqual(bytes)
      expect(restored).toHaveBeenCalledTimes(restoreCalls)
    } finally {
      test.retirement.stop()
      await background.close()
      await readers.close()
    }
  }
)

it('never publishes an empty head for queued-only source content', async () => {
  const test = await profile((source) =>
    source.exec(`DELETE FROM journal_rows;
    INSERT INTO queued_messages(session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state,hold_reason)
    VALUES('unopened','held',1,'{"kind":"message","role":"user","blocks":[{"type":"text","text":"held"}]}','f',1,'h','waiting','manual')`)
  )
  const maintain = vi.spyOn(test.writer, 'maintain')
  await test.retirement.run()
  expect(test.receiptState()).toMatchObject({ phase: 'refused', reason: 'source-queued-only-v1' })
  expect(maintain.mock.calls.filter(([op]) => op.kind === 'import-finish')).toEqual([])
  expect(await test.readers.importState('unopened')).toEqual({ state: 'converting', epoch: null })
})

it.each(['damaged', 'newer'])(
  'settles proven %s source content through real preparation transport at N and 10N',
  async (kind) => {
    for (const count of [128, 1280]) {
      const test = await profile((source) => {
        const row = journalSqlRetryRows(true).find((row) => row.kind === 'item')!
        for (let n = journalSqlRetryRows(true).length; n < count; n++) {
          insertJournalRow(source, 'unopened', { ...row, seq: n + 1, itemId: `history-${n}` })
        }
        source
          .prepare("UPDATE journal_rows SET row_json=? WHERE session_id='unopened' AND seq=?")
          .run(
            kind === 'damaged' ? 'malformed journal content' : '{"v":999999,"kind":"future"}',
            count
          )
      })
      expect(test.source().prepare('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok'
      })
      expect(test.source().prepare('SELECT COUNT(*) AS n FROM journal_rows').get()!.n).toBe(count)
      const bytes = readFileSync(test.filename)
      const restores = join(test.root, 'source-restores')
      const worker = join(test.root, 'count-reader.cjs')
      writeFileSync(
        worker,
        `
const sqlite = require('node:sqlite')
const { workerData } = require('node:worker_threads')
const { appendFileSync } = require('node:fs')
const Original = sqlite.DatabaseSync
sqlite.DatabaseSync = class extends Original {
  constructor(filename, options) { super(filename, options); this.source = filename === workerData.originalFilename }
  prepare(sql) {
    if (this.source && sql === 'SELECT epoch FROM journal_sessions WHERE session_id = ?') appendFileSync(${JSON.stringify(restores)}, 'restore\\n')
    return super.prepare(sql)
  }
}
require(${JSON.stringify(journalSqlReaderPath())})
`
      )
      const readers = new JournalSqlReaderPool(
        journalDomainDatabasePath(test.root),
        test.filename,
        worker
      )
      const conversions = new JournalSqlConversions(test.writer, readers, async () => {})
      const check = vi.fn(async () => {})
      const owner = () =>
        new JournalLegacyRetirement(
          test.root,
          test.writer,
          readers,
          conversions,
          async () => true,
          (error) => test.errors.push(error),
          () => true,
          async () => ({ held: () => true, close: async () => {} }),
          undefined,
          { present: () => {}, check }
        )
      const proof = vi.spyOn(readers, 'legacyProof')
      const ensure = vi.spyOn(conversions, 'ensure')
      try {
        const first = owner()
        await first.run()
        expect(test.receiptState()).toMatchObject({
          phase: 'refused',
          policy: 2,
          reason: kind === 'damaged' ? 'source-corrupt' : 'source-newer'
        })
        expect(readFileSync(restores, 'utf8')).toBe('restore\n')
        first.stop()
        await first.flushCredit()
        proof.mockClear()
        ensure.mockClear()
        check.mockClear()
        for (let n = 0; n < 10; n++) {
          const next = owner()
          await next.run()
          next.stop()
          await next.flushCredit()
          expect(proof).not.toHaveBeenCalled()
          expect(ensure).not.toHaveBeenCalled()
          expect(check).not.toHaveBeenCalled()
          expect(readFileSync(restores, 'utf8')).toBe('restore\n')
        }
        expect(readFileSync(test.filename)).toEqual(bytes)
      } finally {
        await conversions.close()
        await readers.close()
      }
    }
  }
)

it.each(['reader-busy', 'writer-corrupt', 'reader-corrupt'])(
  'separates source diagnosis from recoverable conversion failure (%s)',
  async (fault) => {
    const test = await profile()
    const marker = join(test.root, 'prepare-busy')
    writeFileSync(marker, '')
    const worker = join(test.root, 'transient-reader.cjs')
    writeFileSync(
      worker,
      `
const sqlite = require('node:sqlite')
const { workerData } = require('node:worker_threads')
const { existsSync } = require('node:fs')
const Original = sqlite.DatabaseSync
sqlite.DatabaseSync = class extends Original {
  constructor(filename, options) { super(filename, options); this.source = filename === workerData.originalFilename }
  prepare(sql) {
    if (${JSON.stringify(fault)} !== 'writer-corrupt' && this.source && sql === 'SELECT epoch FROM journal_sessions WHERE session_id = ?' && existsSync(${JSON.stringify(marker)})) {
      throw Object.assign(new Error('source read failed'), { code: 'ERR_SQLITE_ERROR', errcode: ${fault === 'reader-busy' ? 5 : 11} })
    }
    return super.prepare(sql)
  }
}
require(${JSON.stringify(journalSqlReaderPath())})
`
    )
    const readers = new JournalSqlReaderPool(
      journalDomainDatabasePath(test.root),
      test.filename,
      worker
    )
    const conversions = new JournalSqlConversions(test.writer, readers, async () => {})
    const maintain = test.writer.maintain.bind(test.writer)
    vi.spyOn(test.writer, 'maintain').mockImplementation(async (op) => {
      if (fault === 'writer-corrupt' && op.kind === 'import-finish' && existsSync(marker)) {
        throw Object.assign(new Error('destination corrupt'), {
          code: 'ERR_SQLITE_ERROR',
          errcode: 11
        })
      }
      return maintain(op)
    })
    const retirement = new JournalLegacyRetirement(
      test.root,
      test.writer,
      readers,
      conversions,
      async () => true,
      (error) => test.errors.push(error),
      () => true,
      async () => ({ held: () => true, close: async () => {} }),
      undefined,
      { present: () => {}, check: async () => {} }
    )
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      await retirement.run()
      if (fault === 'reader-corrupt') {
        expect(test.receiptState()).toMatchObject({ phase: 'refused', reason: 'source-corrupt' })
        // The normal conversion caller still receives the original SQLite identity.
        await expect(conversions.ensure('unopened')).rejects.toMatchObject({
          code: 'ERR_SQLITE_ERROR',
          errcode: 11
        })
        return
      }
      expect(stored(test)).toBeUndefined()
      expect(test.errors[0]).toMatchObject({
        code: 'ERR_SQLITE_ERROR',
        errcode: fault === 'reader-busy' ? 5 : 11
      })
      unlinkSync(marker)
      await conversions.ensure('unopened')
      now += 3600001
      await retirement.run()
      expect(test.receiptState().phase).toBe('grace')
    } finally {
      retirement.stop()
      await conversions.close()
      await readers.close()
    }
  }
)
