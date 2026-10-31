import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { SqliteStatement } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
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

let root: string
const sweepers: JournalOutcomeSweeper[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-compaction-scaling-'))
})
afterEach(async () => {
  sweepers.splice(0).forEach((sweeper) => sweeper.stop())
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function chat(size: number, bytes = 100): JournalHostDatabase {
  const database = openTestJournalHostDatabase(join(root, `${size}-${bytes}`))
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
  const prepare = database.db.prepare.bind(database.db)
  const spy = vi.spyOn(database.db, 'prepare').mockImplementation((sql) => {
    sqls.push(sql)
    const statement = prepare(sql)
    const counted: SqliteStatement = {
      all: (...args) => {
        const rows = statement.all(...args)
        returned += rows.length
        return rows
      },
      get: (...args) => {
        const row = statement.get(...args)
        returned += Number(!!row)
        return row
      },
      run: (...args) => {
        const result = statement.run(...args)
        removed += Number(result.changes)
        return result
      },
      iterate: function* (...args) {
        for (const row of statement.iterate(...args)) {
          returned++
          yield row
        }
      },
      setReadBigInts: (enabled) => statement.setReadBigInts(enabled)
    }
    return counted
  })
  return () => {
    spy.mockRestore()
    return { returned, removed, sqls }
  }
}

it('bounds every page at N and 10N revisions, without reading or decoding content', () => {
  const measure = (size: number) => {
    const database = chat(size)
    const compaction = new JournalOutcomeCompaction()
    expect(compaction.page(database)).toBe(true) // Selects one source, independently of its size.
    const stop = watch(database)
    expect(compaction.page(database)).toBe(true)
    const work = stop()
    expect(work.returned).toBeLessThanOrEqual(97) // One source, 32 records, two indexed probes each.
    expect(work.removed).toBeGreaterThan(0)
    expect(work.removed).toBeLessThanOrEqual(32)
    for (const sql of work.sqls) {
      expect(sql).not.toContain('value_json')
      const parameters = sql.startsWith('SELECT seq, field') ? [1, 0, '', '', size + 1] : null
      if (parameters) {
        const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters)
        expect(plan.map((row) => row.detail).join(' ')).toContain('SEARCH')
        expect(plan.map((row) => row.detail).join(' ')).not.toContain('TEMP B-TREE')
      }
    }
    return work
  }
  expect(measure(1_000)).toEqual(measure(100))
})

it('does no record work on an unchanged pass at N and 10N, and revisits the former latest on new writes', () => {
  const measure = (size: number) => {
    const database = chat(size)
    const compaction = new JournalOutcomeCompaction()
    while (compaction.page(database)) {
      /* Bounded transactions. */
    }
    const stop = watch(database)
    while (compaction.page(database)) {
      /* Only source metadata is consulted. */
    }
    const idle = stop()
    expect(idle.removed).toBe(0)
    expect(idle.sqls.every((sql) => !/\bFROM journal_outcomes\b/.test(sql))).toBe(true)
    // A committed append changes coverage; the next pass must reconsider the former latest.
    database.transaction((db) => {
      db.prepare(`INSERT INTO journal_outcomes SELECT generation, seq + 1, field, entry_key,
        format, ordinal, value_json, deleted FROM journal_outcomes WHERE field = 'items'
        AND seq = (SELECT MAX(seq) FROM journal_outcomes WHERE field = 'items')`).run()
      db.prepare('UPDATE journal_outcome_epochs SET through_seq = through_seq + 1').run()
    })
    while (compaction.page(database)) {
      /* Bounded transactions. */
    }
    expect(
      database.db.prepare("SELECT COUNT(*) AS n FROM journal_outcomes WHERE field = 'items'").get()
        ?.n
    ).toBe(2)
    return idle
  }
  expect(measure(1_000)).toEqual(measure(100))
})

it('retries a failed deletion without advancing its page and preserves sends between pages', async () => {
  const database = chat(100)
  const compaction = new JournalOutcomeCompaction()
  compaction.page(database)
  const rows = database.db.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()
  database.db.exec(`CREATE TEMP TRIGGER fail_compaction BEFORE DELETE ON journal_outcomes
    BEGIN SELECT RAISE(ABORT, 'injected deletion failure'); END`)
  expect(() => compaction.page(database)).toThrow('injected deletion failure')
  expect(database.db.prepare('SELECT * FROM journal_outcomes ORDER BY rowid').all()).toEqual(rows)
  database.db.exec('DROP TRIGGER fail_compaction')
  expect(compaction.page(database)).toBe(true)
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
  const database = chat(100, 16_384)
  const pages = () => Number(database.db.pragma('page_count', { simple: true }))
  const before = pages()
  const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: async () => {} })
  sweepers.push(sweeper)
  await sweeper.pass()
  expect(pages()).toBeLessThan(before)
  expect(database.db.pragma('freelist_count', { simple: true })).toBe(0)
  const older = new Database(':memory:')
  try {
    const pragma = vi.spyOn(older, 'pragma')
    expect(vacuumJournalPage({ writeAutocommit: (run) => run(older) })).toBe(false)
    expect(pragma.mock.calls).toEqual([['auto_vacuum', { simple: true }]])
  } finally {
    older.close()
  }
})
