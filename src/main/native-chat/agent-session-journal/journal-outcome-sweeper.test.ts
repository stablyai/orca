import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { TestJournalHostDatabase as JournalHostDatabase } from './journal-host-database-test-support'
import type { JournalRow } from './journal-row-schema'
import { restoreJournal } from './journal-open'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { JournalOutcomeSweeper, sweepJournalOutcomePage } from './journal-outcome-cleanup'
import { observeNativeJournalSql } from './journal-native-test-instrumentation'

// The production sweeper over a real database, on its own timers.
const epoch = 'epoch-1'
const base = (seq: number) => ({ v: 4, epoch, seq, ts: 1_000 + seq, fence: 1 })
const epochRow: JournalRow = {
  ...base(1),
  kind: 'epoch',
  reason: 'session_created',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}
const item: JournalRow = {
  ...base(2),
  kind: 'item',
  itemId: 'kept',
  revision: 1,
  body: { kind: 'status', text: 'kept' }
}

let root: string
let database: JournalHostDatabase
const sweepers: JournalOutcomeSweeper[] = []
beforeEach(async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  })
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-sweeper-'))
  database = await openTestJournalHostDatabase(root)
  database.fixtureTransaction((db) => {
    publishTestJournalEpoch(db, 'live', epoch)
    publishJournalOutcomeEpoch(db, 'live', epoch, [epochRow, item])
  })
})
afterEach(async () => {
  sweepers.splice(0).forEach((sweeper) => sweeper.stop())
  vi.useRealTimers()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function started(onError = vi.fn()) {
  const rests = vi.fn(async () => {})
  const sweeper = new JournalOutcomeSweeper({ database: () => database, delay: rests, onError })
  const pass = vi.spyOn(sweeper, 'pass')
  sweepers.push(sweeper.start())
  return { rests, onError, pass }
}

/** A generation no epoch names any more, as a replacement leaves it, holding `keys` records. */
function retire(keys: number): void {
  database.fixtureTransaction((db) => {
    const retired = Number(
      db
        .prepare('INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)')
        .run('gone', 'gone-epoch').lastInsertRowid
    )
    const insert = db.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (?, 1, 'aliases', ?, 1, 's0000000000000001:0000000000000000', ?, 0)`)
    for (let index = 0; index < keys; index++) {
      insert.run(retired, JSON.stringify(`k${index}`), JSON.stringify([`k${index}`, 'v']))
    }
  })
}

const retiredRecords = () =>
  database.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_outcomes
    WHERE generation NOT IN (SELECT generation FROM journal_outcome_epochs)`)
    .get()?.n

it('sweeps a retired generation a minute after launch in paced pages, keeping the live chat', async () => {
  retire(100)
  const { rests, pass } = started()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(retiredRecords()).toBe(100)
  await vi.advanceTimersByTimeAsync(1)
  expect(pass).toHaveBeenCalledTimes(1)
  await pass.mock.results[0].value
  expect(retiredRecords()).toBe(0)
  // Four 32-record pages and the generation row, each its own transaction with a rest after it.
  expect(rests.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(
    database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()?.n
  ).toBe(1)
  expect(restoreJournal(database.db, 'live')?.state.items.has('kept')).toBe(true)
})

it('retries a failed pass at the next periodic pass, and runs none after it stops', async () => {
  retire(10)
  const failure = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' })
  vi.spyOn(database, 'maintenance').mockRejectedValueOnce(failure)
  const { onError, pass } = started()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(pass).toHaveBeenCalledTimes(1)
  await expect(pass.mock.results[0].value).rejects.toBe(failure)
  expect(onError).toHaveBeenCalledWith(failure)
  expect(retiredRecords()).toBe(10)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(pass).toHaveBeenCalledTimes(2)
  await pass.mock.results[1].value
  expect(retiredRecords()).toBe(0)
  retire(10)
  sweepers.forEach((sweeper) => sweeper.stop())
  await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
  expect(retiredRecords()).toBe(10)
})

it('bounds retired discovery, indexed outcome pages and writer identity rechecks at N and 10N', async () => {
  for (const size of [100, 1_000]) {
    database = await openTestJournalHostDatabase(join(root, String(size)))
    let retired = 0
    database.fixtureTransaction((db) => {
      const generation = db.prepare(
        'INSERT INTO journal_outcome_generations (session_id, epoch) VALUES (?, ?)'
      )
      const live = db.prepare('INSERT INTO journal_outcome_epochs VALUES (?, ?, ?, 2, 1, 0)')
      const outcome = db.prepare(`INSERT INTO journal_outcomes VALUES
        (?, ?, 'aliases', ?, 1, 's0000000000000001:0000000000000000', ?, 0)`)
      for (let index = 0; index < size; index++) {
        const id = `live-${index}`
        const key = Number(generation.run(id, epoch).lastInsertRowid)
        live.run(id, epoch, key)
        outcome.run(key, 1, JSON.stringify(id), JSON.stringify([id, 'retained']))
      }
      retired = Number(generation.run('retired', 'previous').lastInsertRowid)
      // Insertion/rowid order disagrees with the existing sequence/key index.
      for (let index = size; index > 0; index--) {
        outcome.run(retired, index, JSON.stringify(`gone-${index}`), JSON.stringify(['gone', 'v']))
      }
    })
    const sqls = new Set<string>()
    let returned = 0
    let statements = 0
    const stop = observeNativeJournalSql(database, (entry) => {
      returned += entry.rows
      statements += Number(entry.method !== 'prepare')
      if (entry.method === 'prepare') {
        sqls.add(entry.sql)
      }
    })
    try {
      let units = 0
      for (;;) {
        returned = 0
        statements = 0
        const more = await sweepJournalOutcomePage(database)
        // Returned rows aren't VM/examined work; bounded ranges/plans below establish access shape.
        expect(returned).toBeLessThanOrEqual(100)
        expect(statements).toBeLessThanOrEqual(105)
        units++
        if (!more) {
          break
        }
        expect(units).toBeLessThanOrEqual(2 * size + 2)
      }
      expect(retiredRecords()).toBe(0)
      expect(database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcomes').get()?.n).toBe(size)
      expect(
        database.db.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()?.n
      ).toBe(size)
      const queries = [...sqls]
      const boundaries = [
        { sql: queries.find((sql) => sql.includes('WHERE generation > ?')), args: [0, retired] },
        {
          sql: queries.find((sql) => sql.includes('ORDER BY seq, field, entry_key')),
          args: [retired]
        },
        { sql: queries.find((sql) => sql.startsWith('SELECT session_id, epoch')), args: [retired] },
        {
          sql: queries.find((sql) => sql.startsWith('SELECT epoch, generation')),
          args: ['retired']
        }
      ]
      for (const { sql, args } of boundaries) {
        expect(sql).toBeDefined()
        const plan = database.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
        const detail = plan.map((row) => row.detail).join(' ')
        expect(detail).toContain('SEARCH')
        expect(detail).not.toContain('TEMP B-TREE')
      }
      sqls.clear()
      // A live-only prefix still advances and completes without inspecting outcomes.
      let remaining = size + 1
      while (await sweepJournalOutcomePage(database)) {
        expect(--remaining).toBeGreaterThan(0)
      }
      expect([...sqls].some((sql) => sql.includes('FROM journal_outcomes'))).toBe(false)
    } finally {
      stop()
    }
  }
})
