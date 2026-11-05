import { observeNativeJournalSql } from './journal-native-test-instrumentation'
import { journalDatabasePath } from './journal-host-database'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { TestJournalHostDatabase as JournalHostDatabase } from './journal-host-database-test-support'
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
import { restoreJournal } from './journal-open'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'

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
  seedOutcomeRows(database, rows)
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
    returned += entry.rows
    removed += entry.changes
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
      expect(sql.replace('length(CAST(value_json AS BLOB)) AS bytes', 'bytes')).not.toContain(
        'value_json'
      )
      const parameters = sql.startsWith('SELECT seq, field') ? [1, 0, '', '', size + 1] : null
      if (parameters) {
        const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
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
    database.fixtureTransaction((db) => {
      db.prepare(`INSERT INTO journal_outcomes SELECT generation, seq + 1, field, entry_key,
        format, ordinal, value_json, deleted FROM journal_outcomes WHERE field = 'items'
        AND seq = (SELECT MAX(seq) FROM journal_outcomes WHERE field = 'items')`).run()
      db.prepare('UPDATE journal_outcome_epochs SET through_seq = through_seq + 1').run()
    })
    while (await compaction.page(database)) {
      /* Bounded transactions. */
    }
    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM journal_outcomes WHERE field = 'items'").get()
        ?.n
    ).toBe(2)
    return idle
  }
  expect(await measure(1_000)).toEqual(await measure(100))
})

it('retries a failed deletion without advancing its page and keeps the chat writable during rests', async () => {
  const database = await chat(100)
  const compaction = new JournalOutcomeCompaction()
  await compaction.page(database)
  const rows = database.db.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
  database.db.exec(`CREATE TRIGGER fail_compaction BEFORE DELETE ON journal_outcomes
    BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`)
  await expect(compaction.page(database)).rejects.toThrow('injected deletion failure')
  expect(database.db.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()).toEqual(rows)
  database.db.exec('DROP TRIGGER fail_compaction')
  while (await compaction.page(database)) {
    /* The failed page is retried, not skipped: every middle revision goes. */
  }
  expect(
    database.db.prepare("SELECT COUNT(*) AS n FROM journal_outcomes WHERE field = 'items'").get()?.n
  ).toBe(2)
  const rig = projectionWriter(database, restoreJournal(database.db, projectionSessionId)!.state)
  let sent = false
  const rested = vi.fn(async () => {
    expect(database.db.isTransaction).toBe(false)
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
  expectProjectionMatches(database, rig.state())
  rig.queue.markClosed()
  await rig.queue.drain()
})

it('reclaims freed pages incrementally, and leaves non-incremental databases alone', async () => {
  const database = await chat(100, 16_384)
  const pages = () => Number(database.db.pragma('page_count', { simple: true }))
  const before = pages()
  const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: async () => {} })
  sweepers.push(sweeper)
  await sweeper.pass()
  expect(pages()).toBeLessThan(before)
  expect(database.db.pragma('freelist_count', { simple: true })).toBe(0)
  const directory = join(root, 'non-incremental')
  await mkdir(directory)
  const older = new Database(journalDatabasePath(directory))
  try {
    older.exec(`CREATE TABLE t (v TEXT); INSERT INTO t VALUES (zeroblob(1000000)); DELETE FROM t`)
  } finally {
    older.close()
  }
  const olderHost = await openTestJournalHostDatabase(directory)
  const olderPages = Number(olderHost.db.pragma('page_count', { simple: true }))
  expect(Number(olderHost.db.pragma('freelist_count', { simple: true }))).toBeGreaterThan(0)
  expect(await vacuumJournalPage(olderHost)).toBe(false)
  expect(Number(olderHost.db.pragma('page_count', { simple: true }))).toBe(olderPages)
})

it.each(['newer', 'missing'] as const)(
  'services healthy successors and vacuum past a %s marker on scheduled retries and a fresh runner',
  async (marker) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const database = await openTestJournalHostDatabase(root)
    const seed = (sessionId: string, revisions: number) =>
      database
        .fixtureTransaction((db) => {
          publishTestJournalEpoch(db, sessionId, 'epoch-1')
          return publishJournalOutcomeEpoch(db, sessionId, 'epoch-1', [
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
        .adopt()
    seed('unsupported', 1)
    const rig = projectionWriter(database, seed('healthy', 100))
    if (marker === 'newer') {
      database.db
        .prepare(`UPDATE journal_rows SET row_json = json_set(row_json, '$.v', 6)
        WHERE session_id = 'unsupported'`)
        .run()
    } else {
      database.db.prepare("DELETE FROM journal_rows WHERE session_id = 'unsupported'").run()
    }
    const unsupported = () => [
      database.db.prepare("SELECT * FROM journal_rows WHERE session_id = 'unsupported'").all(),
      database.db
        .prepare("SELECT * FROM journal_outcome_epochs WHERE session_id = 'unsupported'")
        .all(),
      database.db
        .prepare(`SELECT * FROM journal_outcomes WHERE generation =
        (SELECT generation FROM journal_outcome_epochs WHERE session_id = 'unsupported') ORDER BY seq, field, entry_key`)
        .all()
    ]
    const frozen = unsupported()
    const count = () =>
      Number(
        database.db
          .prepare(`SELECT COUNT(*) AS n FROM journal_outcomes
      WHERE field = 'items' AND generation =
      (SELECT generation FROM journal_outcome_epochs WHERE session_id = 'healthy')`)
          .get()?.n
      )
    const errors: unknown[] = []
    let rests = 0
    const scheduledPasses: Promise<void>[] = []
    const runner = () => {
      const sweeper = new JournalOutcomeSweeper({
        database: () => database,
        now: () => 0,
        delay: async () => {
          rests++
        },
        onError: (error) => errors.push(error)
      }).start()
      const pass = sweeper.pass.bind(sweeper)
      vi.spyOn(sweeper, 'pass').mockImplementation(() => {
        const pending = pass()
        scheduledPasses.push(pending)
        return pending
      })
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
      const pages = Number(database.db.pragma('page_count', { simple: true }))
      const priorRests = rests
      const passCount = scheduledPasses.length
      await vi.advanceTimersByTimeAsync(ms)
      expect(scheduledPasses).toHaveLength(passCount + 1)
      await scheduledPasses.at(-1)
      expect(errors).toEqual([])
      expect(count()).toBe(2)
      expect(unsupported()).toEqual(frozen)
      expect(rests - priorRests).toBeGreaterThan(3)
      // One-page vacuum can visit at most the pre-pass file pages, plus finite metadata/record pages.
      expect(rests - priorRests).toBeLessThan(pages + 20)
      expect(Number(database.db.pragma('page_count', { simple: true }))).toBeLessThan(pages)
      expect(database.db.pragma('freelist_count', { simple: true })).toBe(0)
      expectProjectionMatches(database, rig.state())
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
      // A real SQLite read failure must still reject the scheduled pass without adopting progress.
      await append(121)
      const before = count()
      const failing = runner()
      database.db.exec('ALTER TABLE journal_rows RENAME TO pr36053_unavailable_rows')
      try {
        await vi.advanceTimersByTimeAsync(60_000)
        await expect(scheduledPasses.at(-1)).rejects.toThrow('no such table: journal_rows')
        expect(errors).toHaveLength(1)
        expect(String(errors[0])).toContain('no such table: journal_rows')
        expect(count()).toBe(before)
      } finally {
        database.db.exec('ALTER TABLE pr36053_unavailable_rows RENAME TO journal_rows')
      }
      errors.length = 0
      await assertPass(6 * 60 * 60_000)
      failing.stop()
    } finally {
      rig.queue.markClosed()
      await rig.queue.drain()
    }
  }
)
