import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import {
  journalSqlReaderPath,
  journalSqlWorkerPath
} from './journal-sql-worker-bundle.test-fixture'

const roots: string[] = []
const databases: JournalSqlDatabase[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(databases.splice(0).map((database) => database.close()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const identity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

async function open(root: string) {
  const { journalDatabase } = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: () => {} }
  })
  databases.push(journalDatabase)
  return journalDatabase
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-adapters-'))
  roots.push(root)
  const database = await open(root)
  const journal = await SqlAgentSessionJournal.open({ database, identity, now: () => 100 })
  return { root, database, journal }
}

async function reopen(root: string, database: JournalSqlDatabase, journal: SqlAgentSessionJournal) {
  await journal.close()
  await database.close()
  databases.splice(databases.indexOf(database), 1)
  const next = await open(root)
  return {
    database: next,
    journal: await SqlAgentSessionJournal.open({ database: next, identity, now: () => 200 })
  }
}

const ids = (cards: readonly { messageId: string }[]) => cards.map((card) => card.messageId)

it('holds automatic SQL delivery for an editor and invalidates the hold when its card changes', async () => {
  const { root, database, journal } = await fixture()
  const queue = journal.queuedMessages
  const card = await queue.insert({ messageId: 'A', body: message('A') })
  const editor = { callerKey: 'desktop', editId: 'edit-A' }
  expect(await queue.editLeases.acquire(editor, card)).toMatchObject({ status: 'held' })
  expect(await queue.nextInputCard()).toBeNull()
  expect((await queue.nextInputCard(false))?.messageId).toBe('A')
  // A write can race a previously captured lease; the worker compares the current card identity.
  const facts = queue.facts()
  await queue.update({ messageId: 'A', expectedBodyFingerprint: card.fingerprint, text: 'edited' })
  const read = await journal.reads.queue({
    kind: 'next-input-card',
    automatic: true,
    steer: false,
    now: 100,
    facts
  })
  expect(read).toMatchObject({ kind: 'next-input-card', card: { messageId: 'A' } })
  expect(await queue.editLeases.renew(editor, 'A')).toEqual({ status: 'expired' })

  const edited = (await queue.get('A'))!
  expect(await queue.editLeases.acquire(editor, edited)).toMatchObject({ status: 'held' })
  const restarted = await reopen(root, database, journal)
  expect(await restarted.journal.queuedMessages.editLeases.renew(editor, 'A')).toEqual({
    status: 'expired'
  })
})

it('keeps one ordered queue in SQL and pauses cards from before a reopen until resumed', async () => {
  const { root, database, journal } = await fixture()
  const queue = journal.queuedMessages
  await queue.insert({ messageId: 'A', body: message('A') })
  await queue.insert({ messageId: 'B', body: message('B') })
  await queue.insert({ messageId: 'C', body: message('C') })
  await queue.move({ messageId: 'C', beforeMessageId: 'A' })
  expect(await queue.withdraw(['B'])).toMatchObject([{ messageId: 'B', state: 'withdrawn' }])
  expect(ids(await queue.list())).toEqual(['C', 'A'])
  expect((await queue.nextInputCard())?.messageId).toBe('C')

  const restarted = await reopen(root, database, journal)
  const after = restarted.journal
  const opening = after.openingCursor()
  expect(ids(await after.queuedMessages.list())).toEqual(['C', 'A'])
  await after.markQueueReopen(1)
  expect(after.reopenFloor()).toBeNull()
  expect(after.openingCursor()).toEqual(opening)
  expect((await after.queuedMessages.pauses()).map((pause) => pause.reason)).toEqual(['restarted'])
  expect(await after.queuedMessages.nextInputCard()).toBeNull()

  await after.appendQueueResume(1)
  expect(await after.queuedMessages.pauses()).toEqual([])
  expect((await after.queuedMessages.nextInputCard())?.messageId).toBe('C')
})

it('retains a conservative reopen floor when the mark fails, apart from the opening cursor', async () => {
  const { root, database, journal } = await fixture()
  await journal.queuedMessages.insert({ messageId: 'A', body: message('A') })
  const restarted = await reopen(root, database, journal)
  const after = restarted.journal
  const opening = after.openingCursor()
  const failure = new Error('disk full')
  await restarted.database.serialize('session', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(failure)
  })
  await expect(after.markQueueReopen(1)).rejects.toBe(failure)
  const floor = after.reopenFloor()
  expect(floor).toEqual({
    epoch: after.physicalCursor().epoch,
    sequence: after.physicalCursor().sequence + 1
  })
  expect(after.openingCursor()).toEqual(opening)
  expect((await after.queuedMessages.pauses()).map((pause) => pause.reason)).toEqual(['restarted'])

  await after.markQueueReopen(1)
  expect(after.reopenFloor()).toBeNull()
})

it('reads the latest Stop from SQL and keeps its settlement in host memory only', async () => {
  const { root, database, journal } = await fixture()
  await journal.queuedMessages.insert({ messageId: 'A', body: message('A') })
  const accepted = await journal.acceptStop({
    event: { reason: 'user-stop' },
    fence: 1,
    liveTurnId: 'turn-1'
  })
  expect(accepted.turnId).toBe('turn-1')
  expect(await journal.stopMarks.latest()).toMatchObject({
    event: { reason: 'user-stop', turnId: 'turn-1' }
  })
  expect(await journal.stopMarks.personStopDecides('turn-1')).toBe(true)
  expect(await journal.stopMarks.personStopDecides(null)).toBe(false)
  expect(await journal.queuedMessages.nextInputCard()).toBeNull()

  const edges: number[] = []
  journal.stopMarks.observeSettleEdges(() => edges.push(journal.stopMarks.revision()))
  const settle = await journal.stopMarks.beginSettle(true)
  expect(settle).toEqual({ settling: true })
  expect(await journal.stopMarks.personStopDecides(null)).toBe(true)
  journal.stopMarks.settled(settle, 'turn-2')
  expect(edges).toEqual([1, 2])
  expect((await journal.stopMarks.latest())?.settle).toEqual({ settling: false, turnId: 'turn-2' })
  expect(await journal.stopMarks.personStopDecides('turn-2')).toBe(true)

  const restarted = await reopen(root, database, journal)
  const stop = await restarted.journal.stopMarks.latest()
  expect(stop).toMatchObject({ event: { reason: 'user-stop', turnId: 'turn-1' } })
  expect(stop?.settle).toBeUndefined()
  expect(restarted.journal.stopMarks.revision()).toBe(0)
})

it("lets every writer command plan with the host's unsaved Stop settlement", async () => {
  const { root, database, journal } = await fixture()
  const turn = (turnId: string, state: 'running' | 'interrupted') =>
    journal.appendItem(
      { provider: 'orca', clientMessageId: turnId },
      { kind: 'turn', turnId, state, ...(state === 'interrupted' ? { completedAt: 100 } : {}) },
      { fence: 1, turnScope: { kind: 'thread' } }
    )
  await turn('unsettled', 'running')
  await turn('settling', 'running')
  await turn('stale', 'running')
  await journal.acceptStop({ event: { reason: 'user-stop' }, fence: 1, liveTurnId: null })

  await turn('unsettled', 'interrupted')
  expect((await journal.reads.item('orca:unsettled'))?.body).not.toHaveProperty('outcome')

  await journal.stopMarks.beginSettle(true)
  await turn('settling', 'interrupted')
  expect((await journal.reads.item('orca:settling'))?.body).toMatchObject({
    outcome: 'cancellation'
  })

  await journal.settleStaleState({
    sessionId: 'session',
    fence: 2,
    acquisitionGeneration: 'stopped',
    deathEvidence: { kind: 'exit-observed', detail: '', ownerFence: 1, observedAt: 100 }
  })
  expect((await journal.reads.item('orca:stale'))?.body).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation'
  })
  const notices: string[] = []
  await journal.reads.visitItems({ kinds: ['status'] }, (id) => notices.push(id))
  expect(notices).toEqual([])

  const restarted = await reopen(root, database, journal)
  expect((await restarted.journal.stopMarks.latest())?.settle).toBeUndefined()
})

it('orders a later turn end behind the Stop settlement read', async () => {
  const { database, journal } = await fixture()
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'later' },
    { kind: 'turn', turnId: 'later', state: 'running' },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendStopEvent({ reason: 'user-stop', turnId: 'earlier' }, 1)
  const stop = await journal.reads.latestStop()
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<typeof stop>()
  vi.spyOn(journal.reads, 'latestStop').mockImplementationOnce(() => {
    reached.resolve()
    return release.promise
  })
  const settling = journal.stopMarks.beginSettle(true)
  await reached.promise
  const ended = database.serialize('session', (writer) =>
    writer.write({
      target: {
        sessionId: 'session',
        epoch: journal.physicalCursor().epoch,
        ownerToken: journal.observationHandle()
      },
      operation: {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'later' },
        body: { kind: 'turn', turnId: 'later', state: 'interrupted', completedAt: 100 },
        options: { fence: 1, turnScope: { kind: 'thread' } }
      },
      facts: { identity, stopSettle: journal.stopMarks.fact() },
      savedAt: 100
    })
  )
  release.resolve(stop)
  await settling
  await ended
  expect((await journal.reads.item('orca:later'))?.body).toMatchObject({
    state: 'interrupted',
    outcome: 'cancellation'
  })
})
