import { seedTestOutcomeSweepPopulation } from './journal-native-fixture-test-support'
import { restoreJournalAsync } from './journal-async-open'
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
import { publishJournalOutcomeEpochPlan } from './journal-outcome-write'
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
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  root = await mkdtemp(join(tmpdir(), 'orca-journal-outcome-sweeper-'))
  database = await openTestJournalHostDatabase(root)
  const publication = await database.transaction(async (plan) => {
    publishTestJournalEpoch(plan, 'live', epoch)
    return publishJournalOutcomeEpochPlan(plan, 'live', epoch, [epochRow, item])
  })
  publication.adopt()
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
  return { rests, onError, passes: vi.spyOn(sweeper, 'pass') }
}

/** A generation no epoch names any more, as a replacement leaves it, holding `keys` records. */
function retire(keys: number): Promise<void> {
  return seedTestOutcomeSweepPopulation(database, 0, epoch, keys)
}

const retiredRecords = async () =>
  (
    await database.read((read) =>
      read
        .prepare(`SELECT COUNT(*) AS n FROM journal_outcomes
    WHERE generation NOT IN (SELECT generation FROM journal_outcome_epochs)`)
        .get()
    )
  )?.n

it('sweeps a retired generation a minute after launch in paced pages, keeping the live chat', async () => {
  await retire(100)
  const { rests, passes } = started()
  await vi.advanceTimersByTimeAsync(59_999)
  expect(await retiredRecords()).toBe(100)
  await vi.advanceTimersByTimeAsync(1)
  await passes.mock.results[0]!.value
  expect(await retiredRecords()).toBe(0)
  // Four 32-record pages and the generation row, each its own transaction with a rest after it.
  expect(rests.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(
    (
      await database.read((read) =>
        read.prepare('SELECT COUNT(*) AS n FROM journal_outcome_generations').get()
      )
    )?.n
  ).toBe(1)
  expect(
    (await database.read((read) => restoreJournalAsync(read, 'live')))?.state.items.has('kept')
  ).toBe(true)
})

it('retries a failed pass at the next periodic pass, and runs none after it stops', async () => {
  await retire(10)
  const failure = Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' })
  vi.spyOn(database, 'maintenance').mockRejectedValueOnce(failure)
  const { onError, passes } = started()
  await vi.advanceTimersByTimeAsync(60_000)
  await expect(passes.mock.results[0]!.value).rejects.toBe(failure)
  expect(onError).toHaveBeenCalledWith(failure)
  expect(await retiredRecords()).toBe(10)
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  await passes.mock.results[1]!.value
  expect(await retiredRecords()).toBe(0)
  await retire(10)
  sweepers.forEach((sweeper) => sweeper.stop())
  await vi.advanceTimersByTimeAsync(12 * 60 * 60_000)
  expect(await retiredRecords()).toBe(10)
})
