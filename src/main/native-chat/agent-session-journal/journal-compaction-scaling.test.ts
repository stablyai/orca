import { mutateTestJournalFixture } from './journal-drained-fixture-test-support'
import { onTestFinished, afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  observeNativeJournalSql,
  failNextNativeJournalStatement
} from './journal-native-test-instrumentation'
import { setTestUnsupportedJournalRows } from './journal-native-fixture-test-support'
import { journalDatabasePath, type JournalHostDatabase } from './journal-host-database'
import { restoreJournalAsync } from './journal-async-open'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import Database from '../../sqlite/sync-database'

import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { JournalOutcomeCompaction } from './journal-outcome-compaction'
import { JournalOutcomeSweeper } from './journal-outcome-cleanup'
import { vacuumJournalPage } from './journal-incremental-vacuum'
import {
  projectionBase as base,
  projectionEpochRow,
  projectionSessionId,
  expectProjectionMatches,
  projectionWriter,
  seedOutcomeRows
} from './journal-projection-test-support'
import type { JournalRow } from './journal-row-schema'
import { publishJournalOutcomeEpochPlan } from './journal-outcome-write'

let root: string
const sweepers: JournalOutcomeSweeper[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-compaction-scaling-'))
})
afterEach(async () => {
  sweepers.splice(0).forEach((sweeper) => sweeper.stop())
  vi.restoreAllMocks()
  vi.useRealTimers()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

async function chat(size: number, bytes = 100): Promise<JournalHostDatabase> {
  const database = await openTestJournalHostDatabase(join(root, `${size}-${bytes}`))
  const rows: JournalRow[] = [projectionEpochRow]
  for (let revision = 1; revision <= size; revision++) {
    rows.push({
      ...base(revision + 1),
      kind: 'item',
      itemId: 'answer',
      revision,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'x'.repeat(bytes) }]
      }
    })
  }
  await seedOutcomeRows(database, rows)
  return database
}

/** Counts all returned metadata, SQL statements and affected rows, including probes inside a page. */
function watch(database: JournalHostDatabase) {
  let returned = 0
  let removed = 0
  const sqls: string[] = []
  const stop = observeNativeJournalSql(database, (entry) => {
    if (entry.method === 'prepare') {
      sqls.push(entry.sql)
    }
    if (entry.method === 'all' || entry.method === 'get' || entry.method === 'row') {
      returned += entry.rows
    }
    if (entry.method === 'run') {
      removed += entry.changes
    }
  })
  return () => {
    stop()
    return { returned, removed, sqls }
  }
}

it('bounds every page at N and 10N revisions, without reading or decoding content', async () => {
  const measure = async (size: number) => {
    const database = await chat(size)
    const compaction = new JournalOutcomeCompaction()
    expect(await compaction.page(database)).toBe(true) // Selects one source, independently of its size.
    const stop = watch(database)
    expect(await compaction.page(database)).toBe(true)
    const work = stop()
    expect(work.returned).toBeLessThanOrEqual(97) // One source, 32 records, two indexed probes each.
    expect(work.removed).toBeGreaterThan(0)
    expect(work.removed).toBeLessThanOrEqual(32)
    for (const sql of work.sqls) {
      expect(sql).not.toContain('value_json')
      const parameters = sql.startsWith('SELECT seq, field') ? [1, 0, '', '', size + 1] : null
      if (parameters) {
        const plan = await database.read((read) =>
          read.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
        )
        expect(plan.map((row) => row.detail).join(' ')).toContain('SEARCH')
        expect(plan.map((row) => row.detail).join(' ')).not.toContain('TEMP B-TREE')
      }
    }
    return work
  }
  expect(await measure(1_000)).toEqual(await measure(100))
})

it('does no record work on an unchanged pass at N and 10N, and revisits the former latest on new writes', async () => {
  const measure = async (size: number) => {
    const database = await chat(size)
    const compaction = new JournalOutcomeCompaction()
    while (await compaction.page(database)) {
      /* Bounded transactions. */
    }
    const stop = watch(database)
    while (await compaction.page(database)) {
      /* Only source metadata is consulted. */
    }
    const idle = stop()
    expect(idle.removed).toBe(0)
    expect(idle.sqls.every((sql) => !/\bFROM journal_outcomes\b/.test(sql))).toBe(true)
    // A committed append changes coverage; the next pass must reconsider the former latest.
    const loaded = await database.read((read) => restoreJournalAsync(read, projectionSessionId))
    const rig = projectionWriter(database, loaded!.state)
    await rig.writer.enqueue((seq) => ({
      ...base(seq),
      kind: 'item',
      itemId: 'answer',
      revision: size + 1,
      body: { kind: 'status', text: 'new revision' }
    }))
    rig.queue.markClosed()
    await rig.queue.drain()
    while (await compaction.page(database)) {
      /* Bounded transactions. */
    }
    expect(
      (
        await database.read((read) =>
          read.prepare("SELECT COUNT(*) AS n FROM journal_outcomes WHERE field = 'items'").get()
        )
      )?.n
    ).toBe(2)
    return idle
  }
  expect(await measure(1_000)).toEqual(await measure(100))
})

it('retries a failed deletion without advancing its page and keeps the chat writable during rests', async () => {
  const database = await chat(100)
  let transactionOpen = true
  onTestFinished(
    observeNativeJournalSql(database, (entry) => {
      if (entry.inTransaction !== undefined) {
        transactionOpen = entry.inTransaction
      }
    })
  )
  const compaction = new JournalOutcomeCompaction()
  await compaction.page(database)
  const rows = await database.read((read) =>
    read.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
  )
  await mutateTestJournalFixture(database, (db) => {
    db.exec(`CREATE TRIGGER fail_compaction BEFORE DELETE ON journal_outcomes
    BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`)
  })
  await expect(compaction.page(database)).rejects.toThrow('injected deletion failure')
  expect(
    await database.read((read) =>
      read.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
    )
  ).toEqual(rows)
  await mutateTestJournalFixture(database, (db) => {
    db.exec('DROP TRIGGER fail_compaction')
  })
  while (await compaction.page(database)) {
    /* The failed page is retried, not skipped: every middle revision goes. */
  }
  expect(
    (
      await database.read((read) =>
        read.prepare("SELECT COUNT(*) AS n FROM journal_outcomes WHERE field = 'items'").get()
      )
    )?.n
  ).toBe(2)
  const rig = projectionWriter(
    database,
    (await database.read((read) => restoreJournalAsync(read, projectionSessionId)))!.state
  )
  let sent = false
  const rested = vi.fn(async () => {
    expect(transactionOpen).toBe(false)
    if (!sent) {
      sent = true
      await rig.writer.enqueue((seq) => ({
        ...base(seq),
        kind: 'item',
        itemId: 'sent',
        revision: 1,
        body: { kind: 'status', text: 'arrived during maintenance' }
      }))
    }
  })
  const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: rested })
  sweepers.push(sweeper)
  await sweeper.pass()
  expect(rested).toHaveBeenCalled()
  expect(rig.state().items.has('sent')).toBe(true)
  await expectProjectionMatches(database, rig.state())
  rig.queue.markClosed()
  await rig.queue.drain()
})

it('reclaims freed pages incrementally, and leaves non-incremental databases alone', async () => {
  const database = await chat(100, 16_384)
  const pages = async () =>
    Number((await database.read((read) => read.prepare('PRAGMA page_count').get()))?.page_count)
  const before = await pages()
  const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: async () => {} })
  sweepers.push(sweeper)
  await sweeper.pass()
  expect(await pages()).toBeLessThan(before)
  expect(
    (await database.read((read) => read.prepare('PRAGMA freelist_count').get()))?.freelist_count
  ).toBe(0)
  const olderRoot = join(root, 'non-incremental')
  await mkdir(olderRoot)
  const older = new Database(journalDatabasePath(olderRoot))
  let olderClosed = false
  try {
    older.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES (zeroblob(1000000)); DELETE FROM t`)
    const olderPages = Number(older.pragma('page_count', { simple: true }))
    expect(Number(older.pragma('freelist_count', { simple: true }))).toBeGreaterThan(0)
    older.close()
    olderClosed = true
    const host = await openTestJournalHostDatabase(olderRoot)
    expect(await vacuumJournalPage(host)).toBe(false)
    expect(
      Number((await host.read((read) => read.prepare('PRAGMA page_count').get()))?.page_count)
    ).toBe(olderPages)
  } finally {
    if (!olderClosed) {
      older.close()
    }
  }
})

it.each(['newer', 'missing'] as const)(
  'services healthy successors and vacuum past a %s marker on scheduled retries and a fresh runner',
  async (marker) => {
    vi.useFakeTimers()
    const database = await openTestJournalHostDatabase(root)
    const seed = async (sessionId: string, revisions: number) => {
      const publication = await database.transaction((plan) => {
        publishTestJournalEpoch(plan, sessionId, 'epoch-1')
        return publishJournalOutcomeEpochPlan(plan, sessionId, 'epoch-1', [
          projectionEpochRow,
          ...Array.from({ length: revisions }, (_, index): JournalRow => ({
            ...base(index + 2),
            kind: 'item',
            itemId: 'answer',
            revision: index + 1,
            body: { kind: 'status', text: `${index} ${'x'.repeat(16_384)}` }
          }))
        ])
      })
      return publication.adopt()
    }
    await seed('unsupported', 1)
    const rig = projectionWriter(database, await seed('healthy', 100))
    await setTestUnsupportedJournalRows(database, 'unsupported', marker)
    const unsupported = async () => [
      await database.read((read) =>
        read.prepare("SELECT * FROM journal_rows WHERE session_id = 'unsupported'").all()
      ),
      await database.read((read) =>
        read.prepare("SELECT * FROM journal_outcome_epochs WHERE session_id = 'unsupported'").all()
      ),
      await database.read((read) =>
        read
          .prepare(`SELECT * FROM journal_outcomes WHERE generation =
        (SELECT generation FROM journal_outcome_epochs WHERE session_id = 'unsupported') ORDER BY seq, field, entry_key`)
          .all()
      )
    ]
    const frozen = await unsupported()
    const count = async () =>
      Number(
        (
          await database.read((read) =>
            read
              .prepare(`SELECT COUNT(*) AS n FROM journal_outcomes
      WHERE field = 'items' AND generation =
      (SELECT generation FROM journal_outcome_epochs WHERE session_id = 'healthy')`)
              .get()
          )
        )?.n
      )
    const errors: unknown[] = []
    let rests = 0
    const runner = () => {
      const sweeper = new JournalOutcomeSweeper({
        database: () => database,
        now: () => 0,
        delay: async () => {
          rests++
        },
        onError: (error) => errors.push(error)
      }).start()
      sweepers.push(sweeper)
      return sweeper
    }
    const append = async (revision: number) => {
      for (let n = revision; n < revision + 10; n++) {
        await rig.writer.enqueue((seq) => ({
          ...base(seq),
          kind: 'item',
          itemId: 'answer',
          revision: n,
          body: { kind: 'status', text: `${n} ${'x'.repeat(16_384)}` }
        }))
      }
    }
    const assertPass = async (ms: number) => {
      const pages = Number(
        (await database.read((read) => read.prepare('PRAGMA page_count').get()))?.page_count
      )
      const priorRests = rests
      await vi.advanceTimersByTimeAsync(ms)
      await sweepers.at(-1)!.pass()
      expect(errors).toEqual([])
      expect(await count()).toBe(2)
      expect(await unsupported()).toEqual(frozen)
      expect(rests - priorRests).toBeGreaterThan(3)
      expect(rests - priorRests).toBeLessThan(100)
      expect(
        Number((await database.read((read) => read.prepare('PRAGMA page_count').get()))?.page_count)
      ).toBeLessThan(pages)
      expect(
        (await database.read((read) => read.prepare('PRAGMA freelist_count').get()))?.freelist_count
      ).toBe(0)
      await expectProjectionMatches(database, rig.state())
    }
    const first = runner()
    try {
      await assertPass(60_000)
      await append(101)
      await assertPass(6 * 60 * 60_000)
      first.stop()
      await append(111)
      const restarted = runner()
      await assertPass(60_000)
      restarted.stop()
      // A failed native maintenance unit cannot publish progress or revoke the prior append.
      await append(121)
      const before = await count()
      const failing = runner()
      await failNextNativeJournalStatement(database, 'BEGIN IMMEDIATE', 'maintenance unavailable')
      await vi.advanceTimersByTimeAsync(60_000)
      await failing.pass().catch(() => {})
      expect(errors).toHaveLength(1)
      expect(String(errors[0])).toContain('maintenance unavailable')
      expect(await count()).toBe(before)
      errors.length = 0
      await assertPass(6 * 60 * 60_000)
      failing.stop()
    } finally {
      rig.queue.markClosed()
      await rig.queue.drain()
    }
  }
)
