import { AgentSessionSubscribers } from '../agent-session-wire/publication/subscribers/structured-agent-session-subscribers'
import type { AgentSessionSubscribeEvent } from '../../../shared/agent-session/agent-session-wire'
import Database from '../../sqlite/sync-database'
import { StructuredAgentSessionStatusFeed } from '../agent-session-wire/observations/structured-agent-session-status-feed'
import type { StatusFeedSession } from '../agent-session-wire/observations/structured-agent-session-status-feed-deps'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { openStructuredAgentSessionSqlJournalDatabase } from '../../runtime/agent-session/structured-agent-session-journal-open'
import { journalDatabasePath } from './database/journal-host-database'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalSqlStoreOperation } from './journal-sql-store'
import type { JournalOperationReceipt } from './writing/journal-row-writer'
import { agentJournalTurnBody } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
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
  sessionId: 'session-1',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

const item = (text: string): JournalSqlStoreOperation => ({
  kind: 'item',
  identity: { provider: 'orca', clientMessageId: 'item' },
  body: { kind: 'status', text },
  options: { fence: 1, turnScope: { kind: 'thread' } }
})

async function open(root: string) {
  const errors: unknown[] = []
  const opened = await openStructuredAgentSessionSqlJournalDatabase({
    stateDirectory: root,
    writerPath: journalSqlWorkerPath(),
    readerPath: journalSqlReaderPath(),
    logger: { warn: () => {}, error: (_message, fields) => errors.push(fields.error) }
  })
  databases.push(opened.journalDatabase)
  expect(errors).toEqual([])
  return opened
}

async function fixture(now: () => number = () => 100) {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-store-'))
  roots.push(root)
  const { journalDatabase: database, records } = await open(root)
  expect(records.records.size).toBe(0)
  const journal = await SqlAgentSessionJournal.open({ database, identity, now })
  return { root, database, journal }
}

it('holds automatic delivery for every editor until committed release, expiry or handle close', async () => {
  let now = 100
  const { database, journal } = await fixture(() => now)
  const card = await journal.queuedMessages.insert({
    messageId: 'draft',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] }
  })
  const desktop = { callerKey: 'desktop', editId: 'editing' }
  const phone = { callerKey: 'phone', editId: 'editing' }
  await journal.queuedMessages.editLeases.acquire(desktop, {
    messageId: 'draft',
    fingerprint: card.fingerprint
  })
  now = 200
  expect(
    await journal.queuedMessages.editLeases.acquire(phone, {
      messageId: 'draft',
      fingerprint: card.fingerprint
    })
  ).toMatchObject({ status: 'held', remainingMs: 120_000 })
  await journal.queuedMessages.editLeases.release(desktop, 'draft')
  expect(await journal.queuedMessages.nextInputCard()).toBeNull()
  const heldRevision = journal.queuedMessages.revision()
  await journal.appendSteps([
    {
      kind: 'resolved-item',
      resolution: {
        kind: 'text-snapshot',
        identity: { provider: 'orca', clientMessageId: 'text' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Still writing' }]
        }
      },
      options: { fence: 1, turnScope: { kind: 'thread' } },
      reservedBytes: 4096
    }
  ])
  expect(journal.queuedMessages.revision()).toBe(heldRevision)
  now = 120_200
  const opening = journal.physicalCursor()
  const expired = await SqlAgentSessionJournal.open({ database, identity, now: () => now })
  expect(expired.openingCursor()).toEqual(opening)
  expect(expired.physicalCursor().sequence).toBe(opening.sequence + 1)
  expect(await expired.queuedMessages.nextInputCard()).toMatchObject({ messageId: 'draft' })
  await expired.close()
  await journal.queuedMessages.editLeases.expire()
  expect(journal.queuedMessages.revision()).not.toBe(heldRevision)
  expect(await journal.queuedMessages.nextInputCard()).toMatchObject({ messageId: 'draft' })
  await journal.queuedMessages.editLeases.acquire(phone, {
    messageId: 'draft',
    fingerprint: card.fingerprint
  })
  await journal.close()
  const reopened = await SqlAgentSessionJournal.open({ database, identity, now: () => now })
  expect(await reopened.queuedMessages.editLeases.renew(phone, 'draft')).toEqual({
    status: 'expired'
  })
  await reopened.close()
})

function receipt(adopt: (committed: boolean) => void): JournalOperationReceipt {
  return {
    write: () => {
      throw new Error('the host must never write a SQL receipt')
    },
    committed: () => {
      throw new Error('the host must settle the staged receipt')
    },
    stage: async () => ({
      effects: [
        {
          kind: 'receipt',
          scope: { kind: 'global' },
          receipt: {
            operationId: 'operation',
            sessionId: 'session-1',
            callerKey: 'caller',
            method: 'agentSession.send',
            fingerprint: 'fingerprint',
            acceptedAt: 100,
            status: 'accepted',
            result: { kind: 'journal-row', epoch: 'unassigned', sequence: 0 }
          },
          row: { at: 'first', kinds: ['item'], answer: 'journal-row' }
        }
      ],
      settle: (results) => adopt(results !== undefined)
    })
  }
}

async function foundReceiptSession(database: JournalSqlDatabase): Promise<void> {
  await database.effects([
    {
      kind: 'store',
      mutation: {
        input: {
          kind: 'command',
          command: {
            kind: 'found',
            leaseTtlMs: 30_000,
            legacyTabIds: [],
            request: {
              sessionId: 'session-1',
              location: {
                executionHostId: 'local',
                workspaceId: 'workspace',
                workspaceKind: 'git-worktree',
                wslDistro: null
              },
              provider: 'codex',
              accountHome: { variable: 'CODEX_HOME', path: '/tmp/receipt-codex' },
              expectedFence: null,
              spawnToken: 'spawn',
              claimKeyId: 'key',
              handoffOperationId: null,
              probe: { outcome: 'reservation-unused' },
              operation: {
                callerKey: 'caller',
                operationId: '1800000000000-00000000000000000000000000000000',
                fingerprint: 'found'
              },
              now: 1_800_000_000_000
            }
          }
        }
      }
    }
  ])
}

it('adopts a row-bound receipt before publishing and reads the persisted revision after restart', async () => {
  const { root, database, journal } = await fixture()
  await foundReceiptSession(database)
  const opening = journal.openingCursor()
  expect(opening.sequence).toBe(0)
  expect(journal.wroteBeforeOpen(undefined)).toBe(false)
  expect(journal.wroteBeforeOpen(0)).toBe(true)
  let adopted = false
  const publications: boolean[] = []
  journal.observeCommits(() => publications.push(adopted))
  await journal.write(item('first'), () => ({
    receipt: receipt((committed) => {
      adopted = committed
    })
  }))
  expect(publications).toEqual([true])
  expect(journal.openingCursor()).toEqual(opening)
  expect(journal.cursor().sequence).toBe(1)
  expect(journal.wroteBeforeOpen(1)).toBe(false)
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { kind: 'journal-row', sequence: 1 } }
  })
  const revision = journal.write(item('revised'))
  const reading = journal.readInOrder((reads) => reads.item('orca:item'))
  const closed = journal.close()
  await expect(journal.write(item('after-close'))).rejects.toMatchObject({ code: 'journal_closed' })
  await revision
  expect(await reading).toMatchObject({ revision: 2, body: { text: 'revised' } })
  await closed
  await database.close()
  const reopened = await open(root)
  const next = await SqlAgentSessionJournal.open({ database: reopened.journalDatabase, identity })
  expect(next.wroteBeforeOpen(1)).toBe(true)
  expect(next.openingCursor().sequence).toBe(2)
  expect(next.observationHandle()).not.toBe(journal.observationHandle())
  expect(await next.reads.item('orca:item')).toMatchObject({
    revision: 2,
    body: { text: 'revised' }
  })
})

it('discards staged adoption and the row together when a receipt conflicts', async () => {
  const { database, journal } = await fixture()
  await foundReceiptSession(database)
  await journal.write(item('retained'), () => ({ receipt: receipt(() => {}) }))
  let adopted = true
  await expect(
    journal.write(item('must roll back'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      })
    }))
  ).rejects.toBeInstanceOf(CommandReceiptExistsError)
  expect(adopted).toBe(false)
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'retained' }
  })
  expect(await database.readCommandReceipt({ kind: 'global' }, 'operation')).toMatchObject({
    verdict: 'readable',
    receipt: { result: { sequence: 1 } }
  })
})

it('releases a failed receipt stage and admits the next command without replaying the failure', async () => {
  const { database, journal } = await fixture()
  const needed = new Error('writer admission failed')
  await database.serialize('session-1', (writer) => {
    vi.spyOn(writer, 'write').mockRejectedValueOnce(needed)
  })
  let adopted = true
  await expect(
    journal.write(item('unanswered'), () => ({
      receipt: receipt((committed) => {
        adopted = committed
      })
    }))
  ).rejects.toBe(needed)
  expect(adopted).toBe(false)
  await journal.write(item('later'))
  expect(await journal.reads.item('orca:item')).toMatchObject({
    revision: 1,
    body: { text: 'later' }
  })
})

it('preserves a corrupt database on worker startup refusal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'journal-sql-startup-'))
  roots.push(root)
  const path = journalDatabasePath(root)
  const bytes = Buffer.from('not a database '.repeat(512))
  await writeFile(path, bytes)
  await expect(open(root)).rejects.toMatchObject({
    refusal: { details: { reason: 'journalCorrupt' } }
  })
  expect(await readFile(path)).toEqual(bytes)
})

it('rechecks row-free owner death before answering an attempt-end action read', async () => {
  const { journal } = await fixture()
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'approval' },
    {
      kind: 'approval',
      title: 'Approve',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    },
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendSubmission({
    clientMessageId: 'send',
    payloadFingerprint: 'fp',
    fence: 1,
    body: { kind: 'message', role: 'user', blocks: [] }
  })
  let ended = false
  const capture = (): JournalCurrentWorkAuthority => ({
    handle: journal.observationHandle(),
    record: {
      currentFence: 1,
      ownerObservation: { claimStatus: 'live', unreconciled: false, handoffStage: null }
    },
    child: ended ? null : { fence: 1, heldSends: ['send'] },
    ended: ended ? { fence: 1, rootGone: true, cause: 'exit' } : undefined,
    handingOver: [],
    continuingUnadmitted: [],
    finalizing: [],
    openedThrough: journal.openingCursor(),
    operationalRevision: ended ? 1 : 0
  })
  expect(await journal.readWork(capture, { kind: 'item', itemId: 'orca:approval' })).toEqual({
    kind: 'item',
    current: true
  })
  expect(
    await journal.readWork(capture, { kind: 'attempt-ended', clientMessageId: 'send' })
  ).toEqual({ kind: 'attempt-ended', ended: false })
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const read = journal.reads.work.bind(journal.reads)
  vi.spyOn(journal.reads, 'work').mockImplementationOnce(async (input) => {
    const result = await read(input)
    reached.resolve()
    await release.promise
    return result
  })
  const pending = journal.readWork(capture, { kind: 'attempt-ended', clientMessageId: 'send' })
  await reached.promise
  ended = true
  release.resolve()
  expect(await pending).toEqual({ kind: 'attempt-ended', ended: true })
  expect(await journal.readWork(capture, { kind: 'item', itemId: 'orca:approval' })).toEqual({
    kind: 'item',
    current: false
  })
})

it('publishes SQL status only with recaptured live owners through the existing refresh path', async () => {
  const { journal } = await fixture()
  await journal.write({
    kind: 'item',
    identity: { provider: 'orca', clientMessageId: 'prompt' },
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Read my chat' }] },
    options: { fence: 0, turnScope: { kind: 'thread' } }
  })
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn' },
    { kind: 'turn', turnId: 'turn', state: 'running', userItemId: 'orca:prompt' },
    { fence: 0, turnScope: { kind: 'thread' } }
  )
  const held = new Set<string>()
  const session: StatusFeedSession = {
    journal,
    params: {
      provider: 'codex',
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace',
        workspaceKind: 'git-worktree'
      }
    },
    child: { fence: 0, phase: 'ready', generation: 'generation', heldSends: () => held }
  }
  const logger = { warn: vi.fn(), error: vi.fn() }
  const feed = new StructuredAgentSessionStatusFeed({
    sessions: new Map([['session-1', session]]),
    getConversation: () => null,
    now: () => 999,
    logger
  })
  expect(await feed.journalProjection('session-1', journal)).toMatchObject({ stopping: false })
  await journal.appendStopEvent({ reason: 'user-stop' }, 0)
  const reached = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const published = Promise.withResolvers<void>()
  const alsoPublished = Promise.withResolvers<void>()
  const read = journal.reads.observer.bind(journal.reads)
  vi.spyOn(journal.reads, 'observer').mockImplementationOnce(async (input) => {
    const result = await read(input)
    reached.resolve()
    await release.promise
    return result
  })
  const observations: unknown[] = []
  const pending = feed.publish('session-1', journal, { replay: true }, (projection) => {
    observations.push({
      revision: projection.workRevision,
      held: projection.authority?.child?.heldSends,
      stopping: projection.stopping
    })
    published.resolve()
  })
  const alsoPending = feed.publish('session-1', journal, { replay: true }, (projection) => {
    expect(projection).toMatchObject({
      workRevision: 1,
      stopping: true,
      authority: { child: { heldSends: ['held-without-row'] } }
    })
    alsoPublished.resolve()
  })
  await reached.promise
  expect(feed.readPublished('session-1')).toBeUndefined()
  session.operationalRevision = 1
  held.add('held-without-row')
  const settle = await journal.stopMarks.beginSettle(true)
  release.resolve()
  await pending
  await published.promise
  await alsoPending
  await alsoPublished.promise
  expect(observations).toEqual([{ revision: 1, held: ['held-without-row'], stopping: true }])
  expect(feed.readPublished('session-1')).toMatchObject({
    latestPrompt: 'Read my chat',
    status: 'working',
    stopping: true,
    updatedAt: 100
  })
  expect(logger.warn).not.toHaveBeenCalled()
  const cursor = journal.cursor()
  const stopping = await feed.journalProjection('session-1', journal)
  journal.stopMarks.settled(settle, 'other-turn')
  await feed.publish('session-1', journal, { replay: true })
  expect(feed.readPublished('session-1')).toMatchObject({ status: 'working' })
  expect(feed.readPublished('session-1')).not.toHaveProperty('stopping')
  expect(journal.cursor()).toEqual(cursor)
  expect(stopping?.authority?.stop?.settle).toEqual({ settling: true })
})

it('drops a revoked history invocation after worker dispatch and preserves deduplicated verdicts', async () => {
  const { root, database, journal } = await fixture()
  const cursor = journal.physicalCursor()
  const permit = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  Atomics.store(permit, 0, 1)
  const step = {
    kind: 'settlement' as const,
    settlementId: 'history:one',
    reservedBytes: 4096,
    fence: 1,
    ownerFence: 1,
    resolution: {
      kind: 'history-catch-up' as const,
      expectedCursor: cursor,
      expectedItems: [],
      mutations: [
        {
          kind: 'item' as const,
          identity: { provider: 'orca' as const, clientMessageId: 'history' },
          body: { kind: 'status' as const, text: 'Recovered outside turn' },
          turnScope: { kind: 'thread' as const }
        }
      ],
      permit,
      deadline: Number.MAX_SAFE_INTEGER
    }
  }
  const posted = Promise.withResolvers<void>()
  await database.serialize('observe-dispatch', (writer) => {
    const write = writer.write.bind(writer)
    vi.spyOn(writer, 'write').mockImplementationOnce((command) => {
      const answer = write(command)
      posted.resolve()
      return answer
    })
  })
  const lock = new Database(journalDatabasePath(root))
  let pending: ReturnType<typeof journal.appendSteps> | undefined
  lock.exec('BEGIN IMMEDIATE')
  try {
    pending = journal.appendSteps([step])
    await posted.promise
    Atomics.store(permit, 0, 0)
  } finally {
    lock.exec('ROLLBACK')
    lock.close()
  }
  expect((await pending)?.outcomes).toEqual([{ kind: 'dropped' }])
  expect(journal.physicalCursor()).toEqual(cursor)
  expect(await journal.reads.item('orca:history')).toBeNull()
  Atomics.store(permit, 0, 1)
  expect(await journal.appendSteps([step])).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: true }]
  })
  expect(await journal.reads.item('orca:history')).toMatchObject({
    revision: 1,
    body: { text: 'Recovered outside turn' }
  })
  Atomics.store(permit, 0, 0)
  expect(await journal.appendSteps([step])).toMatchObject({
    outcomes: [{ kind: 'committed', wrote: false }]
  })
  expect((await journal.reads.item('orca:history'))?.revision).toBe(1)
})

it('resolves related-item placement after an earlier step settles its saved turn', async () => {
  const { journal } = await fixture()
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn' },
    agentJournalTurnBody({ turnId: 'turn', state: 'running', userItemId: 'orca:turn' }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'answer' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Before Stop' }] },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
  )
  expect(
    await journal.appendSteps([
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId: 'turn' },
        body: agentJournalTurnBody({
          turnId: 'turn',
          state: 'interrupted',
          userItemId: 'orca:turn',
          completedAt: 200
        }),
        options: { fence: 1, turnScope: { kind: 'thread' } },
        reservedBytes: 4096
      },
      {
        kind: 'resolved-item',
        resolution: {
          kind: 'text-snapshot',
          identity: { provider: 'orca', clientMessageId: 'late-answer' },
          scopeItemIds: ['orca:missing-channel', 'orca:answer'],
          body: {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Trailing text after Stop' }]
          }
        },
        options: { fence: 1, turnScope: { kind: 'thread' } },
        reservedBytes: 4096
      },
      {
        kind: 'resolved-item',
        resolution: {
          kind: 'literal',
          identity: { provider: 'orca', clientMessageId: 'late-notice' },
          body: { kind: 'status', text: 'Earlier tool update' },
          scopeItemIds: ['orca:answer']
        },
        options: { fence: 1, turnScope: { kind: 'thread' } },
        reservedBytes: 4096
      }
    ])
  ).toMatchObject({
    outcomes: [
      { kind: 'committed', wrote: true },
      { kind: 'dropped', reason: 'turn-settled', turnItemId: 'orca:turn' },
      { kind: 'committed', wrote: true }
    ]
  })
  expect(await journal.reads.item('orca:answer')).toMatchObject({
    revision: 1,
    body: { kind: 'message', blocks: [{ type: 'text', text: 'Before Stop' }] },
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
  expect(await journal.reads.item('orca:late-answer')).toBeNull()
  expect(await journal.reads.item('orca:late-notice')).toMatchObject({
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
})

it('refuses stale running items on the writer while permitting completion of existing work', async () => {
  const { journal } = await fixture()
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'turn' },
    agentJournalTurnBody({ turnId: 'turn', state: 'interrupted', userItemId: 'orca:turn' }),
    { fence: 1, turnScope: { kind: 'thread' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'done' },
    { kind: 'tool-call', name: 'read', input: {}, state: 'completed' },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
  )
  await journal.appendItem(
    { provider: 'orca', clientMessageId: 'open' },
    { kind: 'tool-call', name: 'read', input: {}, state: 'running' },
    { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } }
  )
  expect(
    await journal.appendSteps([
      {
        kind: 'resolved-item',
        resolution: {
          kind: 'guarded-item',
          change: 'update',
          identity: { provider: 'orca', clientMessageId: 'done' },
          body: { kind: 'tool-call', name: 'read', input: {}, state: 'running' }
        },
        options: { fence: 1, turnScope: { kind: 'thread' } },
        reservedBytes: 4096
      },
      {
        kind: 'resolved-item',
        resolution: {
          kind: 'guarded-item',
          change: 'open',
          identity: { provider: 'orca', clientMessageId: 'late' },
          body: { kind: 'tool-call', name: 'read', input: {}, state: 'running' }
        },
        options: { fence: 1, turnScope: { kind: 'turn', turnItemId: 'orca:turn' } },
        reservedBytes: 4096
      },
      {
        kind: 'resolved-item',
        resolution: {
          kind: 'guarded-item',
          change: 'close',
          identity: { provider: 'orca', clientMessageId: 'open' },
          body: { kind: 'tool-call', name: 'read', input: {}, state: 'completed' }
        },
        options: { fence: 1, turnScope: { kind: 'thread' } },
        reservedBytes: 4096
      }
    ])
  ).toMatchObject({
    outcomes: [
      { kind: 'dropped', reason: 'item-settled' },
      { kind: 'dropped', reason: 'turn-settled', turnItemId: 'orca:turn' },
      { kind: 'committed', wrote: true }
    ]
  })
  expect(await journal.reads.item('orca:done')).toMatchObject({
    revision: 1,
    body: { state: 'completed' }
  })
  expect(await journal.reads.item('orca:late')).toBeNull()
  expect(await journal.reads.item('orca:open')).toMatchObject({
    revision: 2,
    body: { state: 'completed' },
    turnScope: { kind: 'turn', turnItemId: 'orca:turn' }
  })
})

it('delivers live and saved text with the delivered queue baseline until a queue dependency changes', async () => {
  const { journal } = await fixture()
  const initial = await journal.queuedMessages.insert({
    messageId: 'queued',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'waiting' }] }
  })
  let baseline: {
    queuedMessages: {
      messageId: string
      position: number
      body: typeof initial.body
      state: 'waiting'
    }[]
    queuePause: null
    nextQueuedMessageId: string | null
  } = {
    queuedMessages: [
      {
        messageId: initial.messageId,
        position: initial.position,
        body: initial.body,
        state: 'waiting' as const
      }
    ],
    queuePause: null,
    nextQueuedMessageId: 'queued'
  }
  let queueAvailable = true
  const subscribers = new AgentSessionSubscribers({
    readQueuePublication: () => {
      if (!queueAvailable) {
        throw new Error('queue reader unavailable during text delivery')
      }
      return baseline
    }
  })
  let received = Promise.withResolvers<AgentSessionSubscribeEvent>()
  const close = subscribers.open({
    id: 'desktop',
    sessionId: identity.sessionId,
    journal,
    fence: 1,
    emit: (event) => received.resolve(event)
  })
  const opening = await received.promise
  expect(opening).toMatchObject({ queuedMessages: [{ messageId: 'queued' }] })
  queueAvailable = false
  received = Promise.withResolvers<AgentSessionSubscribeEvent>()
  subscribers.publishLiveText(identity.sessionId, journal, 1, [
    {
      itemId: 'orca:text',
      revision: 1,
      sequence: journal.cursor().sequence,
      observedAt: 100,
      turnScope: { kind: 'thread' },
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'live' }] }
    }
  ])
  expect(await received.promise).toMatchObject({
    type: 'batch',
    batch: { items: [{ body: { blocks: [{ text: 'live' }] } }] }
  })
  received = Promise.withResolvers<AgentSessionSubscribeEvent>()
  await journal.write(item('saved'))
  subscribers.deliverFrames(identity.sessionId, journal, undefined, false)
  expect(await received.promise).toMatchObject({
    type: 'batch',
    batch: { items: [{ body: { text: 'saved' } }] }
  })
  queueAvailable = true
  baseline = { queuedMessages: [], queuePause: null, nextQueuedMessageId: null }
  received = Promise.withResolvers<AgentSessionSubscribeEvent>()
  subscribers.deliverFrames(identity.sessionId, journal)
  expect(await received.promise).toMatchObject({ queuedMessages: [], nextQueuedMessageId: null })
  close()
})
