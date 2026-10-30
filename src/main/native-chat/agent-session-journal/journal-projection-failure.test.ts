import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  saveTestJournalState
} from './journal-host-database-test-support'
import { readJournalSavedState } from './journal-saved-state'
import { restoreJournal } from './journal-open'
import { encodeJournalState } from './journal-state-codec'
import { JournalStopMarks } from './journal-stop-marks'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalRow } from './journal-row-schema'
import {
  expectProjectionMatches,
  projectionBase as base,
  projectionEpoch as epoch,
  projectionEpochRow,
  projectionSessionId as sessionId,
  projectionWriter,
  seedProjectionRows,
  watchJournalStatements
} from './journal-projection-test-support'

let root: string
let database: JournalHostDatabase
const rigs: ReturnType<typeof projectionWriter>[] = []
const user: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'Continue' }]
}
const providerItemId = agentJournalItemKey({
  provider: 'codex',
  threadId: 'thread-1',
  turnId: 'turn-1',
  ordinal: 1
})
const providerHandle = { kind: 'codex', threadId: 'thread-1' } as const

beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'orca-journal-projection-failure-'))
  database = openTestJournalHostDatabase(root)
  database.db.exec('CREATE TABLE test_receipts (sequence INTEGER)')
})
afterEach(async () => {
  for (const rig of rigs.splice(0)) {
    rig.projection.close()
    rig.queue.markClosed()
    await rig.queue.drain()
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

function rigFor(state: Parameters<typeof projectionWriter>[1]) {
  const rig = projectionWriter(database, state)
  rigs.push(rig)
  return rig
}
const status =
  (itemId: string) =>
  (seq: number, ts: number): JournalRow => ({
    ...base(seq),
    ts,
    kind: 'item',
    itemId,
    revision: 1,
    body: { kind: 'status', text: itemId }
  })
function receipt() {
  return {
    write: (db: JournalHostDatabase['db'], row?: JournalRow) => {
      db.prepare('INSERT INTO test_receipts VALUES (?)').run(row?.seq ?? 0)
    },
    committed: vi.fn()
  }
}

it('commits through a statement-only projection failure, skips the lag, repairs after reopen, and propagates an outer abort', async () => {
  const initial = seedProjectionRows(database, [projectionEpochRow])
  saveTestJournalState(database, initial)
  const rig = rigFor(initial)
  const notify = receipt()
  database.db.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ABORT, 'projection statement failed'); END`)
  const exec = vi.spyOn(database.db, 'exec')
  await expect(
    rig.writer.enqueue(
      (seq, ts) => ({
        ...base(seq),
        ts,
        kind: 'submission',
        clientMessageId: 'first-send',
        body: user,
        providerHandle,
        payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, user)
      }),
      notify
    )
  ).resolves.toMatchObject({ seq: 2 })
  expect(notify.committed).toHaveBeenCalledOnce()
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(1)
  expectProjectionMatches(database, rig.state())
  const savepoints = () =>
    exec.mock.calls.filter(([sql]) => sql === 'SAVEPOINT journal_projection').length
  expect(savepoints()).toBe(1)
  await rig.writer.enqueue(status('second'))
  expect(savepoints()).toBe(1)
  await rig.projection.repair()
  expectProjectionMatches(database, rig.state())
  rig.projection.close()
  rig.queue.markClosed()
  const loaded = restoreJournal(database.db, sessionId)
  if (!loaded) {
    throw new Error('missing journal')
  }
  expect(loaded.projectionThrough).toBe(1)
  const reopened = rigFor(loaded.state)
  await reopened.writer.enqueue(status('third'))
  expect(savepoints()).toBe(1)
  expectProjectionMatches(database, reopened.state())
  database.db.exec('DROP TRIGGER fail_projection')
  await reopened.projection.repair()
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(4)
  await reopened.writer.enqueue(status('fourth'))
  expect(savepoints()).toBe(2)
  expectProjectionMatches(database, reopened.state())

  database.db.exec(`CREATE TRIGGER abort_projection BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ROLLBACK, 'outer transaction aborted'); END`)
  const live = reopened.state()
  const before = encodeJournalState(live)
  const aborted = receipt()
  await expect(reopened.writer.enqueue(status('aborted'), aborted)).rejects.toThrow(
    'outer transaction aborted'
  )
  expect(reopened.state()).toBe(live)
  expect(encodeJournalState(live)).toStrictEqual(before)
  expect(aborted.committed).not.toHaveBeenCalled()
  expect(database.db.prepare('SELECT COUNT(*) AS n FROM test_receipts').get()?.n).toBe(1)
  expectProjectionMatches(database, live)
})

it('backs off a failing repair on its own timer, then publishes once the cause clears', async () => {
  const initial = seedProjectionRows(database, [projectionEpochRow])
  saveTestJournalState(database, initial)
  const rig = rigFor(initial)
  database.db.exec(`CREATE TRIGGER fail_projection BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const exec = vi.spyOn(database.db, 'exec')
  const transactions = () => exec.mock.calls.filter(([sql]) => sql === 'BEGIN IMMEDIATE').length
  await rig.writer.enqueue(status('lagging'))
  const appended = transactions()
  // A fixed retry would publish the whole chat ten times in ten minutes.
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(transactions() - appended).toBeGreaterThan(0)
  expect(transactions() - appended).toBeLessThanOrEqual(4)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(1)
  database.db.exec('DROP TRIGGER fail_projection')
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(
    rig.state().lastSequence
  )
  await rig.writer.enqueue(status('healthy'))
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(
    rig.state().lastSequence
  )
})

it('keeps committed catch-up pages and the live state when a later page fails, then resumes after them', async () => {
  const initial = seedProjectionRows(database, [
    projectionEpochRow,
    ...Array.from({ length: 63 }, (_, index) =>
      status(`lagging-${index}`)(index + 2, 1_002 + index)
    )
  ])
  const rig = rigFor(initial)
  database.db.exec(`CREATE TRIGGER fail_page BEFORE INSERT ON journal_state
    WHEN NEW.through_seq > 32 BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const live = rig.state()
  const before = encodeJournalState(live)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(32)
  expect(rig.state()).toBe(live)
  expect(encodeJournalState(live)).toStrictEqual(before)
  expectProjectionMatches(database, live)
  // The failed page keeps its private prefix for the retry.
  expect(rig.projection.holdsCatchUp()).toBe(true)
  database.db.exec('DROP TRIGGER fail_page')
  const watched = watchJournalStatements(database)
  await vi.advanceTimersByTimeAsync(4_000)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(64)
  expect(watched.rowsRead()).toBe(64 - 32)
  expectProjectionMatches(database, live)
  // At the tip the private prefix is released; a later lag decodes a fresh one and converges.
  expect(rig.projection.holdsCatchUp()).toBe(false)
  database.db.exec(`CREATE TRIGGER fail_later BEFORE INSERT ON journal_state
    BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`)
  await rig.writer.enqueue(status('lagging-again'))
  database.db.exec('DROP TRIGGER fail_later')
  const decoded = watched.rowsRead('journal_items')
  await vi.advanceTimersByTimeAsync(4_000)
  expect(watched.rowsRead('journal_items')).toBeGreaterThan(decoded)
  expect(readJournalSavedState(database.db, sessionId, epoch)?.lastSequence).toBe(65)
  expect(rig.projection.holdsCatchUp()).toBe(false)
  expectProjectionMatches(database, rig.state())
})

it('fails the per-commit check when saved state stops decoding, though a full replay still matches', async () => {
  const initial = seedProjectionRows(database, [projectionEpochRow, status('kept')(2, 1_002)])
  saveTestJournalState(database, initial)
  const rig = rigFor(initial)
  database.db.prepare("UPDATE journal_items SET item_json = '{' WHERE item_id = 'kept'").run()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  await expect(rig.writer.enqueue(status('next'))).rejects.toThrow(
    'journal projection and contiguous tail differ from live state'
  )
  const loaded = restoreJournal(database.db, sessionId)
  expect(loaded?.projectionThrough).toBe(0)
  expect(loaded && encodeJournalState(loaded.state)).toStrictEqual(encodeJournalState(rig.state()))
})

it('leaves every live reducer value and the Stop handle unchanged after fold then failed COMMIT', async () => {
  const initial = seedProjectionRows(database, [
    projectionEpochRow,
    {
      ...base(2),
      kind: 'queue',
      messageId: 'card',
      change: { op: 'queued', body: user, position: 1, queuedAt: { epoch, sequence: 1 } }
    },
    {
      ...base(3),
      kind: 'submission',
      clientMessageId: 'send',
      body: user,
      providerHandle,
      handoverRecorded: true,
      payloadFingerprint: agentSessionSendBodyFingerprint(sessionId, user)
    },
    {
      ...base(4),
      kind: 'tombstone',
      itemId: 'stop',
      revision: 1,
      stopEvent: { reason: 'user-stop', at: 1_004 }
    }
  ])
  saveTestJournalState(database, initial)
  const rig = rigFor(initial)
  const stops = new JournalStopMarks({ state: rig.state })
  const settle = stops.beginSettle(true)
  expect(settle).not.toBeNull()
  const live = rig.state()
  const before = encodeJournalState(live)
  const latestStop = stops.latest()
  const notified = receipt()
  const rows: ((seq: number, ts: number) => JournalRow)[] = [
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'item',
      itemId: providerItemId,
      revision: 1,
      body: user
    }),
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'item',
      itemId: 'root-turn',
      revision: 1,
      body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
    }),
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'queue',
      messageId: 'card',
      change: { op: 'held', holdReason: 'edited' }
    }),
    (seq, ts) => ({
      ...base(seq),
      ts,
      kind: 'tombstone',
      itemId: 'resume',
      revision: 1,
      queueResume: true
    })
  ]
  const realExec = database.db.exec.bind(database.db)
  const commit = vi.spyOn(database.db, 'exec').mockImplementation((sql) => {
    if (sql === 'COMMIT') {
      throw new Error('commit failed')
    }
    realExec(sql)
  })
  await expect(rig.writer.enqueueRows(() => rows, notified)).rejects.toThrow('commit failed')
  expect(rig.state()).toBe(live)
  expect(encodeJournalState(live)).toStrictEqual(before)
  expect(stops.latest()).toBe(latestStop)
  expect(stops.latest()?.settle).toBe(settle)
  expect(settle?.settling).toBe(true)
  expect(notified.committed).not.toHaveBeenCalled()
  expectProjectionMatches(database, live)
  commit.mockRestore()
  await rig.writer.enqueueRows(() => rows, notified)
  expect(rig.state().submissions.get('send')?.dispatchState).toBe('accepted')
  expect(rig.state().derivedTurnScope.snapshot()).toBe('root-turn')
  expect(stops.latest()?.settle).toBe(settle)
  stops.settled(settle, 'turn-1')
  expect(stops.latest()?.settle?.settling).toBe(false)
  expectProjectionMatches(database, rig.state())
})
