import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { restoreJournal } from './journal-open'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { JournalOutcomeSweeper } from './journal-outcome-cleanup'

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
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-sweeper-'))
  database = openTestJournalHostDatabase(root)
  database.transaction((db) => {
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
  sweepers.push(sweeper.start())
  return { rests, onError }
}

/** A generation no epoch names any more, as a replacement leaves it, holding `keys` records. */
function retire(keys: number): void {
  database.transaction((db) => {
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
  const { rests } = started()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(retiredRecords()).toBe(100)
  await vi.advanceTimersByTimeAsync(1)
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
  vi.spyOn(database, 'transaction').mockImplementationOnce(() => {
    throw failure
  })
  const { onError } = started()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(onError).toHaveBeenCalledWith(failure)
  expect(retiredRecords()).toBe(10)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  expect(retiredRecords()).toBe(0)
  retire(10)
  sweepers.forEach((sweeper) => sweeper.stop())
  await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
  expect(retiredRecords()).toBe(10)
})
