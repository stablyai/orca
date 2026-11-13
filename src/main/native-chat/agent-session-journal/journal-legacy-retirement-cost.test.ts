import { existsSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { spawnProcess } from '@orca/process-host'
import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { journalDomainDatabasePath } from './database/journal-domain-database'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import * as fileLock from './journal-legacy-file-lock'
import * as profileLock from '../../orcad/instance-lock/orcad-instance-lock-hold'
import * as retirementFiles from './journal-legacy-retirement-files'
import * as sourceReceipt from './database/journal-legacy-source-receipt'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { journalSqlReaderPath } from './journal-sql-worker-bundle.test-fixture'
import { JournalLegacyRetirement } from './journal-legacy-retirement'
import { readJournalLegacyProofPage, type LegacyProofCursor } from './journal-legacy-source-proof'
import { JournalSqlReaderPool } from './journal-sql-reader-pool'
import { prepareJournalDomainImport } from './journal-domain-import'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow } from './durable-rows/journal-row-table'
import { profile, cleanup } from './journal-legacy-retirement.test-fixture'

vi.mock('@orca/process-host', { spy: true })

it('persists one late source refusal across 1 and 10 owners at N and 10N history size', async () => {
  for (const count of [128, 1280]) {
    const check = vi.fn(async () => {})
    const test = await profile(
      (legacy) => {
        const row = journalSqlRetryRows(true).find((row) => row.kind === 'item')!
        for (let n = 0; n < count; n++) {
          insertJournalRow(legacy, 'unopened', {
            ...row,
            seq: journalSqlRetryRows(true).length + n + 1,
            itemId: `preceding-${n}`
          })
        }
        legacy.exec("INSERT INTO journal_rows VALUES('z-orphan','old',1,1,'saved orphan history')")
      },
      { present: () => {}, check }
    )
    const bytes = readFileSync(test.filename)
    const proof = vi.spyOn(test.readers, 'legacyProof')
    const ensure = vi.spyOn(test.conversions, 'ensure')
    await test.retirement.run()
    expect(test.receiptState()).toMatchObject({
      phase: 'refused',
      reason: 'source-orphan',
      policy: 1
    })
    test.retirement.stop()
    await test.retirement.flushCredit()
    proof.mockClear()
    ensure.mockClear()
    check.mockClear()
    for (let owners = 0; owners < 10; owners++) {
      const owner = test.reopen()
      await owner.run()
      owner.stop()
      await owner.flushCredit()
      expect(proof).not.toHaveBeenCalled()
      expect(ensure).not.toHaveBeenCalled()
      expect(check).not.toHaveBeenCalled()
      expect(test.receiptState().phase).toBe('refused')
    }
    expect(readFileSync(test.filename)).toEqual(bytes)
  }
})

it('invalidates every saved refusal descriptor component and rejects unsupported refusal policy', async () => {
  const test = await profile((legacy) =>
    legacy.exec("INSERT INTO journal_outcomes VALUES(901,1,'orphan','key',1,'0','orphan text',0)")
  )
  await test.retirement.run()
  const refused = test.receiptState()
  const proof = vi.spyOn(test.readers, 'legacyProof')
  for (const changed of ['proof', 'observed', 'destination', 'policy', 'reason']) {
    test.saveState({ ...refused, [changed]: changed === 'policy' ? 2 : 'unsupported-or-old' })
    proof.mockClear()
    await test.reopen().run()
    expect(proof.mock.calls.length).toBeGreaterThan(0)
    expect(test.receiptState()).toMatchObject({ phase: 'refused', reason: 'source-orphan' })
  }
  const receipt = String(
    test.db
      .prepare(
        "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-source-copy.v1'"
      )
      .get()!.value
  )
  test.db
    .prepare(
      "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-source-copy.v1'"
    )
    .run(`${receipt}\n`)
  proof.mockClear()
  await test.reopen().run()
  expect(proof).not.toHaveBeenCalled()
  expect(existsSync(test.filename)).toBe(true)
  test.db
    .prepare(
      "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-source-copy.v1'"
    )
    .run(receipt)
  const fresh = await profile()
  fresh.db
    .prepare("INSERT INTO agent_session_store_meta VALUES('journal.legacy-retirement.v1',?)")
    .run(JSON.stringify(refused))
  await fresh.retirement.run()
  expect(fresh.receiptState().phase).toBe('grace')
  const changed = new Database(test.filename)
  changed.prepare("INSERT INTO journal_sessions VALUES('downgrade','folder','new-epoch')").run()
  changed.close()
  proof.mockClear()
  await test.reopen().run()
  expect(proof).not.toHaveBeenCalled()
  expect(test.errors.at(-1)).toMatchObject({
    message: 'legacy source no longer matches its copy receipt'
  })
  expect(existsSync(test.filename)).toBe(true)
})

it('retries an unacknowledged refusal save without replaying proof', async () => {
  const test = await profile((legacy) =>
    legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'owed text')")
  )
  const maintain = test.writer.maintain.bind(test.writer)
  let saves = 0
  vi.spyOn(test.writer, 'maintain').mockImplementation(async (operation) => {
    if (operation.kind === 'legacy-retirement-save' && ++saves === 1) {
      throw new Error('write temporarily unavailable')
    }
    return maintain(operation)
  })
  const proof = vi.spyOn(test.readers, 'legacyProof')
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await test.retirement.run()
  const calls = proof.mock.calls.length
  now = 60001
  await test.retirement.run()
  expect(saves).toBe(2)
  expect(proof).toHaveBeenCalledTimes(calls)
  expect(test.receiptState().phase).toBe('refused')
  expect(existsSync(test.filename)).toBe(true)
})

it('resumes late failed proof pages without rereading completed prefixes at N and 10N', async () => {
  for (const pages of [2, 20]) {
    for (const retries of [1, 10]) {
      const test = await profile((legacy) => {
        legacy.exec('BEGIN')
        const session = legacy.prepare("INSERT INTO journal_sessions VALUES(?,'folder','epoch')")
        const row = legacy.prepare(
          "INSERT INTO journal_rows VALUES(?,'epoch',1,1,'preserved text')"
        )
        for (let n = 0; n < (pages + 1) * 128; n++) {
          const id = `chat-${String(n).padStart(5, '0')}`
          session.run(id)
          row.run(id)
        }
        legacy.exec('COMMIT')
      })
      const ready = test.db.prepare(
        "UPDATE journal_chat_state SET epoch='epoch',last_sequence=1,highest_fence=0 WHERE session_id=?"
      )
      for (let n = 0; n < (pages + 1) * 128; n++) {
        ready.run(`chat-${String(n).padStart(5, '0')}`)
      }
      const actual = test.readers.legacyProof
      const completed = new Map<string, number>()
      let failing = true
      let failed = 0
      let contentPages = 0
      let failedCursor: string | undefined
      const proof = vi.spyOn(test.readers, 'legacyProof').mockImplementation(async (cursor) => {
        const key = JSON.stringify(cursor)
        if (cursor.table === 1 && (failedCursor === key || contentPages === pages) && failing) {
          failedCursor = key
          failed++
          throw new Error('reader exited')
        }
        const result = await actual(cursor)
        completed.set(key, (completed.get(key) ?? 0) + 1)
        if (cursor.table === 1) {
          contentPages++
        }
        return result
      })
      const ensure = vi.spyOn(test.conversions, 'ensure')
      let now = 0
      vi.spyOn(performance, 'now').mockImplementation(() => now)
      await test.retirement.run()
      const prefix = ensure.mock.calls.length
      for (let retry = 0; retry < retries; retry++) {
        now += 3600001
        await test.retirement.run()
      }
      expect(failed).toBe(retries + 1)
      expect(contentPages).toBe(pages)
      expect(proof.mock.calls.length).toBe(completed.size + failed)
      expect(ensure).toHaveBeenCalledTimes(prefix)
      expect([...completed.values()].every((count) => count === 1)).toBe(true)
      expect(
        test.db
          .prepare(
            "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v1'"
          )
          .get()
      ).toBeUndefined()
      failing = false
      now += 3600001
      await test.retirement.run()
      expect(test.receiptState().phase).toBe('grace')
      expect([...completed.values()].every((count) => count === 1)).toBe(true)
      expect(ensure).toHaveBeenCalledTimes(prefix)
      vi.restoreAllMocks()
    }
  }
})

it('yields a failed conversion to its normal owner and probes only the pending session on retries', async () => {
  for (const retries of [1, 10]) {
    const test = await profile((legacy) =>
      legacy.exec("INSERT INTO journal_sessions VALUES('a-completed','folder','empty')")
    )
    const inode = statSync(journalDomainDatabasePath(test.root)).ino
    const normal = test.conversions.ensure
    const ensure = vi.spyOn(test.conversions, 'ensure').mockImplementation(async (id) => {
      if (id === 'unopened') {
        prepareJournalDomainImport(test.source(), id)
        throw new Error('recoverable conversion publication failure')
      }
      return normal(id)
    })
    const state = vi.spyOn(test.readers, 'importState')
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    await test.retirement.run()
    const attempts = ensure.mock.calls.length
    state.mockClear()
    for (let retry = 0; retry < retries; retry++) {
      now += 3600001
      await test.retirement.run()
    }
    expect(ensure).toHaveBeenCalledTimes(attempts)
    expect(state.mock.calls).toEqual(Array.from({ length: retries }, () => ['unopened']))
    expect(
      test.db
        .prepare(
          "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v1'"
        )
        .get()
    ).toBeUndefined()
    await normal('unopened')
    now += 3600001
    await test.retirement.run()
    expect(test.receiptState().phase).toBe('grace')
    expect(ensure).toHaveBeenCalledTimes(attempts)
    expect(statSync(journalDomainDatabasePath(test.root)).ino).toBe(inode)
    vi.restoreAllMocks()
  }
})

it('uses bounded covering key pages independently of duplicate counts and payload bytes', async () => {
  for (const [rows, keys, payload] of [
    [256, 3, 8],
    [2560, 3, 8],
    [256, 3, 8192],
    [256, 128, 8],
    [2560, 1280, 8]
  ]) {
    const test = await profile((legacy) => {
      legacy.exec('BEGIN')
      const session = legacy.prepare("INSERT INTO journal_sessions VALUES(?,'folder','epoch')")
      const row = legacy.prepare('INSERT INTO journal_rows VALUES(?,?,?,1,?)')
      const generation = legacy.prepare('INSERT INTO journal_outcome_generations VALUES(?,?,?)')
      const outcome = legacy.prepare(
        "INSERT INTO journal_outcomes VALUES(?,?,'field','key',1,'0',?,0)"
      )
      for (let key = 0; key < keys!; key++) {
        const id = `key-${String(key).padStart(5, '0')}`
        session.run(id)
        generation.run(key + 1, id, 'epoch')
      }
      for (let n = 0; n < rows!; n++) {
        const key = n % keys!
        row.run(`key-${String(key).padStart(5, '0')}`, 'epoch', n + 1, 'x'.repeat(payload!))
        outcome.run(key + 1, n + 1, 'y'.repeat(payload!))
      }
      legacy.exec('COMMIT')
    })
    const source = test.source()
    const prepare = vi.spyOn(source, 'prepare')
    for (const table of [1, 4]) {
      prepare.mockClear()
      let cursor: LegacyProofCursor | null = { table, after: null }
      let pages = 0
      while (cursor?.table === table) {
        cursor = readJournalLegacyProofPage(source, cursor, test.db).next
        pages++
      }
      const sql = prepare.mock.calls.map(([sql]) => sql)
      const keyQueries = sql.filter((sql) => sql.startsWith('SELECT DISTINCT'))
      const bound = table === 1 ? keys! + 1 : keys!
      expect(pages).toBeLessThanOrEqual(Math.ceil(bound / 128) + 1)
      const lookups = sql.filter((sql) =>
        table === 1
          ? sql.startsWith('SELECT 1 FROM journal_sessions WHERE')
          : sql.startsWith('SELECT session_id,epoch FROM journal_outcome_generations')
      )
      expect(lookups).toHaveLength(bound)
      for (const query of new Set(keyQueries)) {
        expect(query).not.toMatch(/row_json|value_json|OFFSET|rowid/i)
        const args = query.includes('WHERE') ? (table === 1 ? ['key-00000', 'epoch'] : [1]) : []
        const plans = source
          .prepare(`EXPLAIN QUERY PLAN ${query}`)
          .all(...args)
          .map((row) => String(row.detail))
          .join('\n')
        expect(plans).toContain('USING COVERING INDEX')
        expect(plans).not.toMatch(/TEMP B-TREE|SORT/)
        if (query.includes('WHERE')) {
          expect(plans).toContain('SEARCH')
        }
      }
    }
    prepare.mockRestore()
    const old = new Database(test.filename)
    old
      .prepare("INSERT INTO journal_rows VALUES('zz-orphan','missing-epoch',1,1,'saved orphan')")
      .run()
    old.close()
    let cursor: LegacyProofCursor | null = { table: 1, after: null }
    expect(() => {
      while (cursor?.table === 1) {
        cursor = readJournalLegacyProofPage(source, cursor, test.db).next
      }
    }).toThrow('legacy source has orphan content')
    const append = new Database(test.filename)
    append
      .prepare(
        "INSERT INTO journal_outcomes VALUES(999999,1,'field','key',1,'0','saved orphan outcome',0)"
      )
      .run()
    append.close()
    cursor = { table: 4, after: null }
    expect(() => {
      while (cursor?.table === 4) {
        cursor = readJournalLegacyProofPage(source, cursor, test.db).next
      }
    }).toThrow('legacy source has an orphan outcome')
    cursor = { table: 1, after: 'key-00000', epoch: 'epoch' }
    const epochSource = new Database(test.filename)
    epochSource
      .prepare("INSERT INTO journal_rows VALUES('key-00000','wrong-epoch',1,1,'saved other epoch')")
      .run()
    epochSource.close()
    expect(() => readJournalLegacyProofPage(source, cursor!, test.db)).toThrow(
      'legacy source has orphan content'
    )
  }
})

it('classifies only source corruption through the real reader transport and recovers busy/exit/destination failures', async () => {
  for (const fault of ['source-corrupt', 'source-busy', 'source-exit', 'destination-corrupt']) {
    const test = await profile()
    const marker = join(test.root, 'injected-reader-fault')
    writeFileSync(marker, fault)
    const worker = join(test.root, 'fault-reader.cjs')
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
    const sourceBoundary = this.source && sql.startsWith('SELECT rowid AS rowid,session_id,epoch,generation FROM journal_outcome_generations')
    const destinationBoundary = !this.source && sql.startsWith('PRAGMA table_info(')
    if (existsSync(${JSON.stringify(marker)}) && (${JSON.stringify(fault)} === 'destination-corrupt' ? destinationBoundary : sourceBoundary)) {
      if (${JSON.stringify(fault)} === 'source-exit') process.exit(7)
      throw Object.assign(new Error('injected sqlite failure'), { code: 'ERR_SQLITE_ERROR', errcode: ${fault === 'source-busy' ? 5 : 11} })
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
    const proof = vi.spyOn(readers, 'legacyProof')
    const ensure = vi.spyOn(test.conversions, 'ensure')
    const check = vi.fn(async () => {})
    const owner = () =>
      new JournalLegacyRetirement(
        test.root,
        test.writer,
        readers,
        test.conversions,
        async () => true,
        (error) => test.errors.push(error),
        () => true,
        async () => ({ held: () => true, close: async () => {} }),
        undefined,
        { present: () => {}, check }
      )
    let now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    try {
      const retirement = owner()
      await retirement.run()
      if (fault === 'source-corrupt') {
        expect(test.receiptState()).toMatchObject({ phase: 'refused', reason: 'source-corrupt' })
        proof.mockClear()
        ensure.mockClear()
        check.mockClear()
        for (let n = 0; n < 10; n++) {
          now += 3600001
          await retirement.run()
        }
        retirement.stop()
        await retirement.flushCredit()
        await owner().run()
        expect(proof).not.toHaveBeenCalled()
        expect(ensure).not.toHaveBeenCalled()
        expect(check).not.toHaveBeenCalled()
      } else {
        expect(
          test.db
            .prepare(
              "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-retirement.v1'"
            )
            .get()
        ).toBeUndefined()
        if (fault !== 'source-exit') {
          expect(test.errors[0]).toMatchObject({
            code: 'ERR_SQLITE_ERROR',
            errcode: fault === 'source-busy' ? 5 : 11
          })
        }
        unlinkSync(marker)
        now += 3600001
        await retirement.run()
        expect(test.receiptState().phase).toBe('grace')
      }
      expect(existsSync(test.filename)).toBe(true)
    } finally {
      await readers.close()
      vi.restoreAllMocks()
    }
  }
})

it('settles terminal retirement before writer admission on the real minute timer', async () => {
  for (const disposition of [
    'absent',
    'no-source',
    'uncertifiable',
    'nonempty-wal',
    'complete',
    'refused',
    'ineligible'
  ]) {
    const test = await profile(
      disposition === 'refused'
        ? (legacy) =>
            legacy.exec("INSERT INTO journal_rows VALUES('orphan','old',1,1,'saved orphan')")
        : undefined
    )
    if (disposition === 'absent') {
      test.db
        .prepare("DELETE FROM agent_session_store_meta WHERE key='journal.legacy-source-copy.v1'")
        .run()
    } else if (['no-source', 'uncertifiable', 'nonempty-wal'].includes(disposition)) {
      const receipt = JSON.parse(
        String(
          test.db
            .prepare(
              "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-source-copy.v1'"
            )
            .get()!.value
        )
      )
      if (disposition === 'nonempty-wal') {
        receipt.wal = { kind: 'nonempty' }
      } else {
        receipt.disposition =
          disposition === 'no-source' ? 'no-source-at-initialization' : 'uncertifiable'
      }
      test.db
        .prepare(
          "UPDATE agent_session_store_meta SET value=? WHERE key='journal.legacy-source-copy.v1'"
        )
        .run(JSON.stringify(receipt))
    }
    if (disposition === 'complete') {
      await test.retirement.run()
      test.arm()
      await test.retirement.run()
      expect(existsSync(test.filename)).toBe(false)
    }
    if (disposition === 'refused') {
      await test.retirement.run()
      expect(test.receiptState().phase).toBe('refused')
    }
    const factory = fileLock.createJournalLegacyFileEligibility
    vi.spyOn(fileLock, 'createJournalLegacyFileEligibility').mockImplementation(() => ({
      ...factory(),
      present: () => {}
    }))
    vi.spyOn(profileLock, 'ownsOrcadProfileDirectory').mockReturnValue(true)
    const spawn = vi.mocked(spawnProcess).mockClear()
    spawn.mockImplementation(() => {
      const helper = Object.assign(new ChildProcess(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough()
      })
      queueMicrotask(() => helper.emit('exit', 4))
      cleanup.push(() => {
        helper.stdin.destroy()
        helper.stdout.destroy()
        helper.stderr.destroy()
      })
      return helper
    })
    const maintain = vi.spyOn(test.writer, 'maintain')
    const proof = vi.spyOn(test.readers, 'legacyProof')
    const presence = vi.spyOn(retirementFiles, 'legacyFilePresent')
    const observations = vi.spyOn(sourceReceipt, 'readJournalLegacySourceReceipt')
    const identities = vi.spyOn(retirementFiles, 'legacyDestinationMain')
    const maintenance = new JournalSqlBackgroundMaintenance(
      test.writer,
      { database: async (operation) => readJournalSqlDatabase(test.db, operation) },
      test.conversions,
      new JournalSqlActivity(),
      (error) => test.errors.push(error)
    )
    maintenance.ownLegacySource(test.root, test.readers)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.spyOn(performance, 'now').mockImplementation(() => Date.now())
    try {
      await maintenance.start()
      const initial = maintain.mock.calls.filter(([operation]) =>
        operation.kind.startsWith('legacy-retirement')
      ).length
      presence.mockClear()
      observations.mockClear()
      identities.mockClear()
      for (let wake = 1; wake <= (disposition === 'ineligible' ? 1440 : 100); wake++) {
        await vi.advanceTimersByTimeAsync(60000)
        await maintenance.settled()
        if (wake === 10 || wake === 100 || wake === 1440) {
          expect(
            maintain.mock.calls.filter(([operation]) =>
              operation.kind.startsWith('legacy-retirement')
            )
          ).toHaveLength(initial)
          expect(proof).not.toHaveBeenCalled()
          expect(spawn).toHaveBeenCalledTimes(disposition === 'ineligible' ? 1 : 0)
          if (disposition === 'refused' || disposition === 'ineligible') {
            expect(observations.mock.calls.length).toBeLessThanOrEqual(wake)
            expect(identities.mock.calls.length).toBeLessThanOrEqual(wake)
          }
          if (disposition === 'complete') {
            expect(
              presence.mock.calls.filter(([path]) => path === test.filename).length
            ).toBeLessThanOrEqual(wake)
          }
        }
      }
      if (disposition === 'ineligible') {
        identities.mockResolvedValue('changed-synthetic-main')
        await vi.advanceTimersByTimeAsync(60000)
        await maintenance.settled()
        expect(spawn).toHaveBeenCalledTimes(2)
        expect(proof).not.toHaveBeenCalled()
      }
      const beforeClose = maintain.mock.calls.filter(([operation]) =>
        operation.kind.startsWith('legacy-retirement')
      ).length
      maintenance.stop()
      await maintenance.settled()
      expect(
        maintain.mock.calls.filter(([operation]) => operation.kind.startsWith('legacy-retirement'))
      ).toHaveLength(beforeClose)
      if (disposition === 'ineligible') {
        const fresh = new JournalLegacyRetirement(
          test.root,
          test.writer,
          test.readers,
          test.conversions,
          async () => true,
          (error) => test.errors.push(error),
          () => true
        )
        await fresh.run()
        expect(spawn).toHaveBeenCalledTimes(3)
        fresh.stop()
        await fresh.flushCredit()
      }
      if (disposition === 'complete') {
        writeFileSync(test.filename, 'recreated old-build history')
        await test.retirement.run()
        expect(
          maintain.mock.calls.filter(([operation]) => operation.kind === 'legacy-retirement-state')
            .length
        ).toBeGreaterThan(1)
        expect(readFileSync(test.filename, 'utf8')).toBe('recreated old-build history')
      }
    } finally {
      maintenance.stop()
      await maintenance.settled()
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  }
})

it('cancels before admitting another proof unit and still flushes grace credit on close', async () => {
  const cancelled = await profile()
  const actual = cancelled.readers.legacyProof
  const proof = vi.spyOn(cancelled.readers, 'legacyProof')
  const ensure = vi.spyOn(cancelled.conversions, 'ensure')
  proof.mockImplementation(async (cursor) => {
    const result = await actual(cursor)
    cancelled.retirement.stop()
    return result
  })
  await cancelled.retirement.run()
  await cancelled.retirement.run()
  expect(proof).toHaveBeenCalledOnce()
  expect(ensure).not.toHaveBeenCalled()
  expect(existsSync(cancelled.filename)).toBe(true)

  const grace = await profile()
  let mono = 0n
  vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => mono)
  const wall = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(wall)
  await grace.retirement.run()
  const save = vi.spyOn(grace.writer, 'maintain')
  mono = 21600000000000n
  vi.mocked(Date.now).mockReturnValue(wall + 21600000)
  await grace.retirement.run()
  expect(grace.receiptState().credit).toBe(21600000)
  mono += 3600000000000n
  vi.mocked(Date.now).mockReturnValue(wall + 25200000)
  grace.retirement.stop()
  await grace.retirement.flushCredit()
  expect(grace.receiptState().credit).toBe(25200000)
  expect(
    save.mock.calls.filter(([operation]) => operation.kind === 'legacy-retirement-save')
  ).toHaveLength(2)
})

it('invalidates partial session progress when the destination descriptor changes', async () => {
  const test = await profile((legacy) =>
    legacy.exec("INSERT INTO journal_sessions VALUES('a-completed','folder','empty')")
  )
  const normal = test.conversions.ensure
  let failed = false
  const ensure = vi.spyOn(test.conversions, 'ensure').mockImplementation(async (id) => {
    if (id === 'unopened' && !failed) {
      failed = true
      throw new Error('reader exited during conversion')
    }
    return normal(id)
  })
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  await test.retirement.run()
  vi.spyOn(retirementFiles, 'legacyDestinationMain').mockResolvedValue('different-synthetic-main')
  now = 60001
  await test.retirement.run()
  expect(ensure.mock.calls.map(([id]) => id)).toEqual([
    'a-completed',
    'unopened',
    'a-completed',
    'unopened'
  ])
  expect(test.receiptState().phase).toBe('grace')
  expect(existsSync(test.filename)).toBe(true)
})
