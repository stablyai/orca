import { expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/agent-session/view/live-read/structured-agent-session-reducer'
import { structuredAgentSessionSendingItemIds } from '../../../shared/agent-session/view/structured-agent-session-sending'
import { createStructuredAgentSessionPublicationWiring } from '../agent-session-wire/host/structured-agent-session-publication-wiring'
import { StructuredAgentSessionStatusFeed } from '../agent-session-wire/observations/structured-agent-session-status-feed'
import { AgentSessionSubscribers } from '../agent-session-wire/publication/subscribers/structured-agent-session-subscribers'
import {
  HOST_TEST_LOCATION,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD,
  hostTestAttachParams,
  hostTestMessage
} from '../agent-session-wire/host/testing/structured-agent-session-host-test-data.test-fixture'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionSubscribeEvent
} from '../../../shared/agent-session/agent-session-wire'
import * as frameBounds from '../agent-session-wire/publication/history/agent-session-bounded-frames'
import { refreshPublishedWork } from '../agent-session-wire/publication/subscribers/agent-session-work-refresh'
import type { Subscriber } from '../agent-session-wire/publication/subscribers/agent-session-subscribe-input'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import { readJournalDomainHistoryFrame } from './journal-domain-history-page'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { readJournalDomainSubmissionAttempt } from './journal-domain-submission-records'
import { JournalSqlCommand } from './journal-sql-command'
import { readJournalSqlPoint } from './journal-sql-point-read'
import { SqlAgentSessionJournal } from './journal-sql-store'
import type { JournalSqlWorkResult } from './journal-work-read'
import type { JournalWriterCommand } from './journal-writer-command'

type ReaderCounts = {
  read: (kind: string) => void
  work: (answer: JournalSqlWorkResult) => void
}

/** Use the real SQLite writer and reader procedures in this process to count both sides' decodes. */
function inProcessSql(
  db: Database.Database,
  now: () => number,
  counts?: ReaderCounts
): JournalSqlDatabase {
  const target = { sessionId: HOST_TEST_SESSION, epoch: 'epoch', ownerToken: 'owner' }
  const cursor = { epoch: target.epoch, sequence: 10 }
  const writer = new JournalSqlCommand(db, '')
  migrateJournalDomainSchema(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES(?,?,?,?,1)`).run(
    target.sessionId,
    HOST_TEST_LOCATION.workspaceId,
    target.epoch,
    cursor.sequence
  )
  const port = {
    write: async (command: JournalWriterCommand) => {
      db.exec('BEGIN IMMEDIATE')
      try {
        const commit = await writer.apply(command, now())
        db.exec('COMMIT')
        return commit
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    }
  }
  let ordered = Promise.resolve()
  const database = {
    openSession: async () => ({
      target,
      commit: {
        cursor,
        value: cursor,
        inputChanged: false,
        keys: [],
        items: [],
        inputKeys: [],
        effects: []
      }
    }),
    readers: {
      point: async (request: Parameters<typeof readJournalSqlPoint>[1]) => {
        counts?.read(request.operation.kind)
        const result = readJournalSqlPoint(db, request)
        if (result.kind === 'work') {
          counts?.work(result.answer)
        }
        return result
      },
      domainHistoryFrame: async (
        request: Parameters<typeof readJournalDomainHistoryFrame>[1],
        work: Parameters<typeof readJournalDomainHistoryFrame>[2]
      ) => {
        counts?.read('history')
        const frame = readJournalDomainHistoryFrame(db, request, work)
        if (frame.work) {
          counts?.work(frame.work)
        }
        return frame
      }
    },
    sending: { urgency: () => ({}) },
    serialize: <T>(_: string, run: (value: typeof port) => Promise<T>) => {
      const next = ordered.then(() => run(port))
      ordered = next.then(
        () => {},
        () => {}
      )
      return next
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The test replaces every database port the live journal uses here.
  return database as unknown as JournalSqlDatabase
}

// PR #45057: a provider receipt used to decode the unchanged prompt on its writer and status reader.
it.each([64, 640])(
  'records and delivers a receipt without decoding the %i KiB prompt',
  async (sizeKiB) => {
    const db = new Database(':memory:')
    const time = 1_800_000_000_000
    let at = time
    const now = () => at
    const sessionId = HOST_TEST_SESSION
    const id = 'send'
    const handle = codexProviderHandle(HOST_TEST_THREAD)
    const marker = 'receipt-performance-prompt'
    const body = hostTestMessage(marker.padEnd(sizeKiB * 1024, 'x'))
    const dispatch = { clientMessageId: id, fence: 1, turnScope: { kind: 'thread' as const } }
    try {
      const journal = await SqlAgentSessionJournal.open({
        database: inProcessSql(db, now),
        identity: {
          sessionId,
          workspaceId: HOST_TEST_LOCATION.workspaceId,
          hostId: 'local',
          agent: 'codex',
          providerHandle: handle
        },
        now
      })
      await journal.write({
        kind: 'submission',
        input: {
          clientMessageId: id,
          body,
          payloadFingerprint: 'prompt',
          fence: 1,
          origin: 'client',
          source: { kind: 'user' },
          handoverRecorded: true
        }
      })
      at += 1
      const pending = await journal.write({
        kind: 'dispatch',
        input: { ...dispatch, state: 'pending' }
      })

      let publication: void | Promise<void> = undefined
      const journalPublished = vi.fn()
      const subscribers = new AgentSessionSubscribers({
        readWorkFrame: (...args) => feed.journalProjection.workFrame(...args),
        readCachedWork: (...args) => feed.journalProjection.cachedWork(...args),
        onJournalPublished: journalPublished,
        now
      })
      const deliverFrames = vi.spyOn(subscribers, 'deliverFrames')
      const observe = vi.fn()
      const observeRows = vi.fn()
      const afterCommit = vi.fn()
      const afterSettleEdge = vi.fn()
      const workChanged = vi.fn()
      const client = {
        requestFailures: { observe, forget: () => {} },
        subscribers,
        publishJournal: vi.fn(() => {
          journalPublished()
          publication = feed.publish(sessionId, journal)
        })
      }
      const logger = { warn: vi.fn(), error: vi.fn() }
      const sessions = createStructuredAgentSessionPublicationWiring({
        client: () => client,
        delivery: () => ({ afterCommit, afterSettleEdge }),
        logger: () => logger,
        opened: () => {},
        workChanged,
        now,
        observeRows: () => observeRows
      })
      const backing = agentSessionRecordFixture({
        sessionId,
        provider: 'codex',
        providerHandleChain: [
          { handle, linkId: 'link', origin: 'created', mintedAtFence: 1, observedAt: at }
        ]
      })
      const record = agentSessionConversationView({
        ...backing,
        lease: { ...backing.lease, claimStatus: 'live' }
      })
      const feed = new StructuredAgentSessionStatusFeed({
        sessions,
        getConversation: () => record,
        now,
        logger
      })
      sessions.set(sessionId, {
        journal,
        params: hostTestAttachParams(1),
        child: { fence: 1, generation: 'child', phase: 'ready', heldSends: () => new Set([id]) }
      })
      await feed.publish(sessionId, journal)
      const before = await feed.journalProjection(sessionId, journal)
      expect(before?.state.summary.latestPrompt).toContain(marker)
      expect(before?.work?.restatedSubmissions).toMatchObject([
        { clientMessageId: id, dispatchState: 'pending' }
      ])

      let state = EMPTY_STRUCTURED_AGENT_SESSION
      const end = vi.fn()
      const publications = vi.fn()
      const settled = vi.fn()
      const stopPublications = sessions.observeConversationPublications(sessionId, {
        next: publications,
        error: end
      })
      const stopSettled = sessions.observeSettledTurns(sessionId, journal, settled)
      const emit = vi.fn(
        (event: Parameters<typeof reduceStructuredAgentSession>[1] & { type: 'event' }) => {
          state = reduceStructuredAgentSession(state, event, now())
        }
      )
      const close = subscribers.open({
        id: 'reader',
        sessionId,
        journal,
        fence: 1,
        readsProviderReceipts: true,
        end,
        emit: (event) => emit({ type: 'event', event })
      })
      const sending = () =>
        structuredAgentSessionSendingItemIds([], state.submissions, state.writtenAtById)
      await vi.waitFor(() => {
        if (end.mock.calls.length) {
          throw end.mock.calls[0]![0]
        }
        expect(state.submissions).toMatchObject([{ clientMessageId: id, dispatchState: 'pending' }])
      })
      expect(sending()).toEqual(new Set(['orca:send']))
      const excluded = [
        client.publishJournal,
        journalPublished,
        observe,
        observeRows,
        afterCommit,
        afterSettleEdge,
        workChanged,
        publications,
        settled
      ]
      for (const observer of excluded) {
        observer.mockClear()
      }
      emit.mockClear()
      const parse = vi.spyOn(JSON, 'parse')
      const promptDecodes = () => parse.mock.calls.filter(([text]) => text.includes(marker)).length
      try {
        at += 2
        const receipt = await journal.write({
          kind: 'dispatch-written',
          handoverCursor: pending.cursor,
          clientMessageId: id,
          fence: 1,
          providerReceipt: true,
          observedAt: at
        })
        await publication
        await vi.waitFor(() => expect(state.cursor).toEqual(receipt.cursor))
        expect(emit).toHaveBeenCalledExactlyOnceWith({
          type: 'event',
          event: expect.objectContaining({
            type: 'batch',
            batch: {
              cursor: receipt.cursor,
              items: [],
              removedItemIds: [],
              submissions: [expect.objectContaining({ clientMessageId: id, writtenAt: at })]
            }
          })
        })
        expect(state.writtenAtById.get(id)).toBe(at)
        expect(sending().size).toBe(0)
        expect(promptDecodes()).toBe(0)
        for (const observer of excluded) {
          expect(observer).not.toHaveBeenCalled()
        }
        expect(sessions.lastActivityAt(sessionId)).toBe(at)
        expect(deliverFrames).toHaveBeenCalledOnce()
        expect(deliverFrames.mock.calls[0]?.at(-1)).toEqual(pending.cursor)
        expect(receipt).toMatchObject({
          cursor: { epoch: pending.cursor.epoch, sequence: pending.cursor.sequence + 1 },
          inputChanged: false,
          requestEvents: [],
          publication: { writtenOnly: true, items: [] }
        })
        const current = await feed.journalProjection(sessionId, journal)
        expect(promptDecodes()).toBe(0)

        // Reopening at the head owes a work restatement, but has no catch-up page to decorate.
        const resumed = vi.fn()
        const stopResumed = subscribers.open({
          id: 'resumed',
          sessionId,
          journal,
          fence: 1,
          cursor: receipt.cursor,
          readsProviderReceipts: true,
          emit: resumed,
          end
        })
        try {
          await vi.waitFor(() =>
            expect(resumed).toHaveBeenCalledWith(
              expect.objectContaining({
                type: 'batch',
                batch: expect.objectContaining({
                  cursor: receipt.cursor,
                  submissions: [expect.objectContaining({ clientMessageId: id, writtenAt: at })]
                })
              })
            )
          )
          expect(promptDecodes()).toBe(0)
        } finally {
          stopResumed()
        }
        expect(current).toMatchObject({
          ...receipt.cursor,
          lastActivityAt: at,
          state: before?.state
        })
        expect(
          readJournalDomainSubmissionAttempt(db, { sessionId, epoch: 'epoch' }, id, false)
            ?.submission
        ).toMatchObject({ dispatchState: 'pending', writtenAt: at })
        expect(promptDecodes()).toBe(0)

        at += 1
        const redispatched = await journal.write({
          kind: 'dispatch',
          input: { ...dispatch, state: 'pending' }
        })
        await vi.waitFor(() => expect(state.cursor).toEqual(redispatched.cursor))
        expect(state.writtenAtById.get(id)).toBeUndefined()
        expect(sending()).toEqual(new Set(['orca:send']))

        at += 1
        await journal.write({
          kind: 'dispatch',
          input: { clientMessageId: id, fence: 1, state: 'accepted', providerIdentity: null }
        })
        await publication
        const accepted = await feed.journalProjection(sessionId, journal)
        expect(promptDecodes()).toBeGreaterThan(0)
        expect(accepted?.acceptedSendKey).not.toBe(before?.acceptedSendKey)
        expect(logger.warn).not.toHaveBeenCalled()
      } finally {
        parse.mockRestore()
        close()
        stopPublications()
        stopSettled()
      }
    } finally {
      db.close()
    }
  }
)

it.each([16, 160])('reuses warm receipt work with %i outstanding sends', async (size) => {
  const db = new Database(':memory:')
  let at = 1_800_000_000_000
  const now = () => ++at
  const sessionId = HOST_TEST_SESSION
  const handle = codexProviderHandle(HOST_TEST_THREAD)
  const read = vi.fn()
  const indexBuilds: (() => number)[] = []
  const journal = await SqlAgentSessionJournal.open({
    database: inProcessSql(db, now, {
      read,
      work: ({ result }) => {
        if (result.kind === 'state') {
          const sends = result.state.restatedSubmissions
          const index = vi.spyOn(sends, 'map')
          indexBuilds.push(() => index.mock.calls.length * sends.length)
        }
      }
    }),
    identity: {
      sessionId,
      workspaceId: HOST_TEST_LOCATION.workspaceId,
      hostId: 'local',
      agent: 'codex',
      providerHandle: handle
    },
    now
  })
  const body = hostTestMessage('Count receipt publication work')
  const ids = Array.from({ length: size }, (_, index) => `pending-${index}`)
  const dispatch = (id: string) =>
    journal.prepareHandover({
      clientMessageId: id,
      fence: 1,
      turnScope: { kind: 'thread' },
      body
    })
  const attempts = new Map<string, Awaited<ReturnType<typeof dispatch>>>()
  const count = () => indexBuilds.reduce((sum, visits) => sum + visits(), 0)
  const cursor = () => journal.cursor()
  const subscribers = new AgentSessionSubscribers({
    now,
    readWorkFrame: (...args) => feed.journalProjection.workFrame(...args),
    readCachedWork: (...args) => feed.journalProjection.cachedWork(...args)
  })
  const storageLane = vi.spyOn(journal, 'readInOrder')
  const end = vi.fn()
  const sessions = createStructuredAgentSessionPublicationWiring({
    client: () => ({
      requestFailures: { observe: () => {}, forget: () => {} },
      subscribers,
      publishJournal: () => {}
    }),
    delivery: () => ({ afterCommit: () => {}, afterSettleEdge: () => {} }),
    logger: () => ({ warn: vi.fn(), error: vi.fn() }),
    opened: () => {},
    now,
    observeRows: () => undefined
  })
  const backing = agentSessionRecordFixture({
    sessionId,
    provider: 'codex',
    providerHandleChain: [
      { handle, linkId: 'link', origin: 'created', mintedAtFence: 1, observedAt: now() }
    ]
  })
  const record = agentSessionConversationView({
    ...backing,
    lease: { ...backing.lease, claimStatus: 'live' }
  })
  let held: ReadonlySet<string> = new Set(ids)
  let heldEnumerations = 0
  const feed = new StructuredAgentSessionStatusFeed({
    sessions,
    getConversation: () => record,
    now,
    logger: { warn: vi.fn(), error: vi.fn() }
  })
  const close: (() => void)[] = []
  const open = (id: string, from?: ReturnType<typeof cursor>, capable = true) => {
    const emit = vi.fn<(event: AgentSessionSubscribeEvent) => void>()
    const stop = subscribers.open({
      id,
      sessionId,
      journal,
      fence: 1,
      cursor: from,
      readsProviderReceipts: capable,
      emit,
      end
    })
    close.push(stop)
    return emit
  }
  const batches = (emit: ReturnType<typeof open>) =>
    emit.mock.calls.map(([event]) => event).filter((event) => event.type === 'batch')
  const restatement = (emit: ReturnType<typeof open>) =>
    batches(emit).flatMap((event) => event.batch.submissions)
  const stamp = (id: string, observedAt = now()) =>
    journal.markDispatchWritten({
      clientMessageId: id,
      fence: 1,
      handoverCursor: attempts.get(id)!.handoverCursor!,
      providerReceipt: true,
      observedAt
    })

  try {
    for (const id of ids) {
      await journal.appendSubmission({
        clientMessageId: id,
        body,
        payloadFingerprint: id,
        fence: 1,
        origin: 'client',
        handoverRecorded: true
      })
      attempts.set(id, await dispatch(id))
    }
    for (let index = 0; index < AGENT_SESSION_HISTORY_MAX_LIMIT; index++) {
      await journal.appendItem(
        { provider: 'orca', clientMessageId: `tail-${index}` },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Newer row' }] },
        { fence: 1, turnScope: { kind: 'thread' } }
      )
    }
    const heldIds = new Set(ids)
    const iterateHeld = heldIds[Symbol.iterator].bind(heldIds)
    vi.spyOn(heldIds, Symbol.iterator).mockImplementation(() => {
      heldEnumerations++
      return iterateHeld()
    })
    held = heldIds
    sessions.set(sessionId, {
      journal,
      params: hostTestAttachParams(1),
      child: { fence: 1, generation: 'child', phase: 'ready', heldSends: () => held }
    })
    const readers = [open('first'), open('second')]
    const older = open('older', undefined, false)
    await vi.waitFor(() => {
      for (const emit of [...readers, older]) {
        expect(restatement(emit)).toHaveLength(size)
      }
    })
    expect(count()).toBe(size)
    expect(heldEnumerations).toBe(1)
    const baseline = () => {
      read.mockClear()
      storageLane.mockClear()
      return count()
    }
    const noRestatementReads = (built: number, ordinaryReads: readonly string[]) => {
      expect(read.mock.calls.map(([kind]) => kind)).toEqual(ordinaryReads)
      expect(count()).toBe(built)
    }
    const id = ids[0]!
    const beforeReceipt = cursor()
    const pinnedStamp = now()
    const built = baseline()
    for (const emit of [...readers, older]) {
      emit.mockClear()
    }
    await stamp(id, pinnedStamp)
    await vi.waitFor(() => {
      for (const emit of readers) {
        expect(restatement(emit)).toEqual([
          expect.objectContaining({ clientMessageId: id, writtenAt: pinnedStamp })
        ])
      }
    })
    noRestatementReads(built, [])
    expect(storageLane).not.toHaveBeenCalled()
    expect(heldEnumerations).toBe(1)
    expect(older).not.toHaveBeenCalled()
    close.pop()?.()

    for (const kind of ['snapshot', 'resume', 'reset'] as const) {
      baseline()
      const head = cursor()
      const emit = open(
        kind,
        kind === 'snapshot' ? undefined : kind === 'resume' ? head : { ...head, epoch: 'retired' }
      )
      const expectedReads =
        kind === 'snapshot'
          ? ['history']
          : kind === 'resume'
            ? ['projected-stop-notes']
            : ['history', 'projected-stop-notes']
      await vi.waitFor(() => {
        expect(restatement(emit)).toHaveLength(size)
        expect(read).toHaveBeenCalledTimes(expectedReads.length)
      })
      for (const [event] of emit.mock.calls) {
        if (event.type === 'snapshot' || event.type === 'reset') {
          expect(event.page.submissions).toEqual([])
        }
      }
      expect(restatement(emit).find((send) => send.clientMessageId === id)?.writtenAt).toBe(
        pinnedStamp
      )
      noRestatementReads(built, expectedReads)
      close.pop()?.()
    }

    const durable = open('durable-catch-up', beforeReceipt)
    await vi.waitFor(() => {
      expect(restatement(durable)[0]).toMatchObject({ clientMessageId: id, writtenAt: pinnedStamp })
      expect(read.mock.calls).toContainEqual(['history'])
    })
    close.pop()?.()

    const work = await feed.journalProjection.work(sessionId, journal)
    if (!work) {
      throw new Error('missing cached work')
    }
    baseline()
    const stopped = new AbortController()
    const subscriber: Subscriber = {
      id: 'closing',
      sessionId,
      cursor: cursor(),
      fence: 1,
      stopped: stopped.signal,
      boundedFrames: true,
      emit: () => {}
    }
    const originalReader = frameBounds.subscriberHistoryReader
    const budget = vi.spyOn(frameBounds, 'subscriberHistoryReader').mockImplementation((input) => ({
      ...originalReader(input),
      budgetBytes: 1024
    }))
    const chunk = Promise.withResolvers<void>()
    const delivery = Promise.withResolvers<void>()
    const emit = vi.fn(async () => {
      chunk.resolve()
      await delivery.promise
    })
    try {
      const refreshing = refreshPublishedWork(
        { emit, isActive: () => !stopped.signal.aborted },
        subscriber,
        journal,
        work,
        () => true,
        { hostNow: now() }
      )
      await chunk.promise
      stopped.abort()
      const before = cursor()
      await stamp(ids[1]!)
      expect(cursor().sequence).toBe(before.sequence + 1)
      delivery.resolve()
      await refreshing
      expect(emit).toHaveBeenCalledOnce()
      expect(subscriber.workView).toBeUndefined()
      expect(storageLane).not.toHaveBeenCalled()
      noRestatementReads(built, [])
    } finally {
      delivery.resolve()
      budget.mockRestore()
    }

    baseline()
    for (const emit of readers) {
      emit.mockClear()
    }
    const backlog = ids.slice(2, 34)
    for (const pending of backlog) {
      await stamp(pending)
    }
    await vi.waitFor(() => {
      for (const emit of readers) {
        expect(
          restatement(emit).filter((send) => backlog.includes(send.clientMessageId))
        ).toHaveLength(backlog.length)
      }
    })
    noRestatementReads(built, [])

    baseline()
    held = new Set(ids.slice(1))
    await feed.journalProjection.work(sessionId, journal)
    expect(read.mock.calls).toEqual([['work']])
    expect(count()).toBe(built + size)
    const changed = baseline()
    for (const emit of readers) {
      emit.mockClear()
    }
    subscribers.deliverFrames(sessionId, journal, undefined, false)
    await vi.waitFor(() => {
      for (const emit of readers) {
        expect(restatement(emit)).toHaveLength(size)
        expect(restatement(emit).find((send) => send.clientMessageId === id)).toMatchObject({
          dispatchState: 'unknown',
          writtenAt: pinnedStamp
        })
      }
    })
    noRestatementReads(changed, [])

    baseline()
    for (const emit of readers) {
      emit.mockClear()
    }
    held = heldIds
    await dispatch(id)
    await vi.waitFor(() => {
      expect(
        readers.every((emit) =>
          restatement(emit).some(
            (send) =>
              send.clientMessageId === id &&
              send.dispatchState === 'pending' &&
              send.writtenAt === undefined
          )
        )
      ).toBe(true)
    })
    expect(count()).toBeGreaterThan(changed)
    expect((await journal.reads.submission(id))?.writtenAt).toBeUndefined()
    expect(read.mock.calls).toContainEqual(['submission'])
    expect(end).not.toHaveBeenCalled()
  } finally {
    for (const stop of close) {
      stop()
    }
    db.close()
  }
})
