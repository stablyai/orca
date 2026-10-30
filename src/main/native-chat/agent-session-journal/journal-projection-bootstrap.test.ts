import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalItemIdentity,
  type AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import {
  createTrackedJournalOpener,
  insertTestJournalRow,
  openTestJournalHostDatabase,
  publishTestJournalEpoch,
  liveTestJournalRows,
  updateTestJournalRowJson
} from './journal-host-database-test-support'
import { AgentSessionJournal } from './journal-store'
import {
  clearJournalSavedState,
  readJournalSavedState,
  sweepJournalSavedState
} from './journal-saved-state'
import { replayJournal, restoreJournal } from './journal-open'
import { JournalProjectionCatchUp } from './journal-projection-catch-up'
import { startJournalStateBackfill } from './journal-state-backfill'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import { deleteJournalEpochRows } from './journal-row-table'
import {
  expectProjectionMatches,
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  replayedPrefixCoverage,
  seedProjectionRows,
  watchJournalStatements
} from './journal-projection-test-support'

const identity: AgentSessionJournalIdentity = {
  sessionId,
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}
let root: string
let database: JournalHostDatabase
const journals = createTrackedJournalOpener()
let backfill: { stop: () => void } | undefined
const childItemId = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})
// A crashed host left this child working, so opening it appends an unverifiable revision.
const workingChild: JournalRow = {
  ...base(2),
  kind: 'item',
  itemId: childItemId,
  revision: 1,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'subagent', id: 'child', label: 'Audit', state: 'working', groupId: 'turn-1' }]
  }
}
const legacyItem = (seq: number): JournalRow => ({
  ...base(seq),
  kind: 'item',
  itemId: `legacy-${seq}`,
  revision: 1,
  body: { kind: 'status', text: 'Saved before projections existed' }
})
const legacyChat = (rows: number) =>
  seedProjectionRows(database, [
    projectionEpochRow,
    ...Array.from({ length: rows - 1 }, (_, index) => legacyItem(index + 2))
  ])
// Saved coverage straight from its row, so checks between timer windows read no journal rows.
const coverage = (session = sessionId) =>
  database.db.prepare('SELECT through_seq FROM journal_state WHERE session_id = ?').get(session)
    ?.through_seq
const nextItem = (ordinal: number): AgentJournalItemIdentity => ({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-2',
  ordinal
})
const reply = (text: string): AgentJournalItemBody => ({
  kind: 'message',
  role: 'assistant',
  blocks: [{ type: 'text', text }]
})
// Every slice overruns, so a catch-up rests after each page.
function restAfterEveryPage() {
  let tick = 0
  return vi.spyOn(performance, 'now').mockImplementation(() => (tick += 30))
}
const publications = (statements: readonly string[]) =>
  statements.filter((sql) => /^\s*(INSERT|DELETE)[\s\S]*journal_(items|entries|state)/.test(sql))

beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-bootstrap-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  backfill?.stop()
  await journals.closeAll()
  vi.restoreAllMocks()
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

it('keeps recovery writes behind coverage zero, repairs the current epoch after rollover, and paces closed-chat bootstrap', async () => {
  seedProjectionRows(database, [projectionEpochRow, workingChild])
  database.db.exec(`CREATE TRIGGER fail_bootstrap BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ABORT, 'bootstrap failed'); END`)
  const exec = vi.spyOn(database.db, 'exec')
  const journal = journals.track(
    new AgentSessionJournal({ identity, database, mintEpoch: () => 'rolled' })
  )
  await journal.open()
  expect(journal.cursor()).toEqual({ epoch, sequence: 3 })
  expect(journal.itemBody(childItemId)).toMatchObject({ blocks: [{ state: 'unverifiable' }] })
  expect(readJournalSavedState(database.db, sessionId, epoch)).toBeNull()
  expect(exec.mock.calls.filter(([sql]) => sql.startsWith('SAVEPOINT'))).toEqual([])
  expect(restoreJournal(database.db, sessionId)?.projectionThrough).toBe(0)
  const recovered = restoreJournal(database.db, sessionId)
  if (!recovered) {
    throw new Error('missing recovered journal')
  }
  expectProjectionMatches(database, recovered.state)

  // A rollover keeps its epoch when its saved state fails; the repair then captures the new epoch.
  await journal.rollEpoch('session_created', 1)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')).toBeNull()
  database.db.exec('DROP TRIGGER fail_bootstrap')
  await vi.advanceTimersByTimeAsync(1_000)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')?.lastSequence).toBe(
    journal.cursor().sequence
  )
  expect(readJournalSavedState(database.db, sessionId, epoch)).toBeNull()
  await journal.close()

  database.transaction((db) => {
    clearJournalSavedState(db, sessionId)
    for (let index = 0; index < 300; index++) {
      insertTestJournalRow(db, sessionId, {
        ...base(index + 2),
        epoch: 'rolled',
        kind: 'item',
        itemId: `closed-${index}`,
        revision: 1,
        body: { kind: 'status', text: 'Saved before projections existed' }
      })
    }
  })
  const before = liveTestJournalRows(database.db, sessionId)
  const rests: number[] = []
  const prefixes: (number | null)[] = []
  let tick = 0
  vi.spyOn(performance, 'now').mockImplementation(() => {
    tick += 10
    return tick
  })
  vi.spyOn(Date, 'now').mockImplementation(() => 10_000 - tick)
  const repairOpen = vi.fn(async () => false)
  backfill = startJournalStateBackfill(
    {
      database: () => database,
      repairOpen,
      rest: async (ms) => {
        rests.push(ms)
        prefixes.push(replayedPrefixCoverage(database))
      }
    },
    (error) => {
      throw error
    }
  )
  await vi.advanceTimersByTimeAsync(59_999)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')).toBeNull()
  await vi.advanceTimersByTimeAsync(1)
  const saved = readJournalSavedState(database.db, sessionId, 'rolled')
  expect(saved?.lastSequence).toBe(301)
  // Before each of ten pages and the final check, so an open chat can take over at a boundary.
  expect(repairOpen).toHaveBeenCalledTimes(11)
  expect(rests.length).toBeGreaterThan(1)
  expect(rests.every((ms) => ms >= 25 * 9)).toBe(true)
  // Every rest sees a committed prefix that, with its tail, folds to the full replay.
  expect(prefixes).not.toContain(null)
  expect(new Set(prefixes).size).toBeGreaterThan(2)
  expect(liveTestJournalRows(database.db, sessionId)).toStrictEqual(before)
  if (!saved) {
    throw new Error('missing background projection')
  }
  expectProjectionMatches(database, saved)
  database.transaction((db) => publishTestJournalEpoch(db, sessionId, 'older-writer'))
  sweepJournalSavedState(database)
  for (const table of ['journal_state', 'journal_items', 'journal_entries']) {
    expect(
      database.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(sessionId)
        ?.n
    ).toBe(0)
  }
  backfill.stop()
})

it('serves a send between catch-up pages, then projects the next send incrementally', async () => {
  legacyChat(100)
  const watched = watchJournalStatements(database)
  const exec = vi.spyOn(database.db, 'exec')
  const savepoints = () =>
    exec.mock.calls.filter(([sql]) => sql === 'SAVEPOINT journal_projection').length
  const journal = journals.track(new AgentSessionJournal({ identity, database }))
  await journal.open()
  expect(journal.cursor()).toEqual({ epoch, sequence: 100 })
  expect(publications(watched.statements)).toEqual([])
  restAfterEveryPage()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(coverage()).toBe(32)

  // The send commits at once on the lane while the catch-up rests, and skips the projection.
  const scope = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(nextItem(1), reply('Sent between pages'), scope)
  expect(journal.cursor().sequence).toBe(101)
  expect(savepoints()).toBe(0)
  expect(coverage()).toBe(32)

  await vi.advanceTimersByTimeAsync(60_000)
  expect(coverage()).toBe(101)
  expect(replayedPrefixCoverage(database)).toBe(101)
  await journal.appendItem(nextItem(2), reply('Projected'), scope)
  expect(savepoints()).toBe(1)
  expect(coverage()).toBe(102)
})

it('stops a catch-up at close, and the next open resumes after its last page', async () => {
  legacyChat(100)
  const pacing = restAfterEveryPage()
  const first = journals.track(new AgentSessionJournal({ identity, database }))
  await first.open()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(coverage()).toBe(32)
  await first.close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(coverage()).toBe(32)

  pacing.mockRestore()
  const watched = watchJournalStatements(database)
  const reopened = journals.track(new AgentSessionJournal({ identity, database }))
  await reopened.open()
  await vi.advanceTimersByTimeAsync(1_000)
  // The open replays the 68 rows after the first page, and the catch-up folds only those.
  expect(watched.rowsRead()).toBe(68 + 68)
  expect(replayedPrefixCoverage(database)).toBe(100)
})

it('drops a catch-up that a rollover replaced, without writing the retired epoch', async () => {
  legacyChat(100)
  restAfterEveryPage()
  const journal = journals.track(
    new AgentSessionJournal({ identity, database, mintEpoch: () => 'rolled' })
  )
  await journal.open()
  await vi.advanceTimersByTimeAsync(1_000)
  expect(coverage()).toBe(32)
  const retired = new JournalProjectionCatchUp(database, sessionId, epoch)
  expect(await retired.load(async () => true)).toBe(true)
  await journal.rollEpoch('session_created', 1)
  expect(retired.page()).toBe('retired')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(readJournalSavedState(database.db, sessionId, 'rolled')?.lastSequence).toBe(
    journal.cursor().sequence
  )
  expect(
    database.db.prepare('SELECT COUNT(*) AS n FROM journal_items WHERE epoch = ?').get(epoch)?.n
  ).toBe(0)
})

it('lets one of two catch-ups on the same saved view commit, then the other continues from it', async () => {
  legacyChat(64)
  const runners = [
    new JournalProjectionCatchUp(database, sessionId, epoch),
    new JournalProjectionCatchUp(database, sessionId, epoch)
  ]
  for (const runner of runners) {
    expect(await runner.load(async () => true)).toBe(true)
  }
  expect(runners[0].page()).toBe('advanced')
  expect(runners[1].page()).toBe('stale')
  expect(await runners[1].load(async () => true)).toBe(true)
  expect(runners[1].page()).toBe('advanced')
  expect(runners[0].page()).toBe('stale')
  expect(replayedPrefixCoverage(database)).toBe(64)
})

it('stops the repair timer of a chat whose open fails after adopting its history', async () => {
  seedProjectionRows(database, [projectionEpochRow, workingChild])
  database.db.exec(`CREATE TRIGGER fail_rows BEFORE INSERT ON journal_rows
    BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`)
  const watched = watchJournalStatements(database)
  await expect(journals.open({ identity, stateDirectory: root })).rejects.toThrow()
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(publications(watched.statements)).toEqual([])
})

it('keeps the pages before damage and parks a closed chat until its rows change, then publishes it', async () => {
  legacyChat(100)
  database.transaction((db) => updateTestJournalRowJson(db, sessionId, 40, '{"unreadable":'))
  const watched = watchJournalStatements(database)
  backfill = startJournalStateBackfill(
    { database: () => database, repairOpen: async () => false, rest: async () => undefined },
    (error) => {
      throw error
    }
  )
  // Each pass is measured on its own; the replay checks between passes read rows too.
  const readDuring = async (ms: number) => {
    const before = watched.rowsRead()
    await vi.advanceTimersByTimeAsync(ms)
    return watched.rowsRead() - before
  }
  // Page one commits; page two holds the damage, so it writes nothing and the chat parks.
  expect(await readDuring(60_000)).toBe(64)
  expect(coverage()).toBe(32)
  expect(restoreJournal(database.db, sessionId)?.damage).toStrictEqual(
    replayJournal(database.db, sessionId)?.damage
  )
  expect(await readDuring(6 * 60 * 60_000)).toBe(0)
  // A new row re-arms it; the retry decodes the kept page's view and reads only the next page.
  database.transaction((db) => insertTestJournalRow(db, sessionId, legacyItem(101)))
  expect(await readDuring(6 * 60 * 60_000)).toBe(32)
  expect(coverage()).toBe(32)

  // An older build replaces the chat with a clean epoch ending at the same sequence; only the
  // epoch tells it apart from the parked history.
  database.transaction((db) => {
    deleteJournalEpochRows(db, sessionId, epoch)
    publishTestJournalEpoch(db, sessionId, 'clean')
    insertTestJournalRow(db, sessionId, { ...projectionEpochRow, epoch: 'clean' })
    for (let seq = 2; seq <= 101; seq++) {
      insertTestJournalRow(db, sessionId, { ...legacyItem(seq), epoch: 'clean' })
    }
  })
  await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
  const published = readJournalSavedState(database.db, sessionId, 'clean')
  expect(published?.lastSequence).toBe(101)
  expect(published?.items.size).toBe(100)
  if (!published) {
    throw new Error('missing published clean epoch')
  }
  expectProjectionMatches(database, published)
})
