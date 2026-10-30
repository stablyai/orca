import { observeAsyncQuestions } from './structured-agent-session-question-observation.test-fixture'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { structuredRewindCut } from './structured-rewind-cut'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../shared/agent-session-journal-item-key'
import { messageQuestionSourceId } from '../message-question-source'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import { currentJournal } from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

import { asyncQuestionBody } from './structured-agent-session-async-question.test-fixture'
import { currentWork } from './structured-agent-session-leftover-settlement.test-fixture'

function asyncRows(current: QueuedMessageTestRig) {
  const payload = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (!payload || Array.isArray(payload) || payload.asyncQuestions === null) {
    throw new Error('expected negotiated v2 payload')
  }
  return payload.asyncQuestions
}

it('requires provider delivery rather than host acceptance, and keeps later questions in a settled replay', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  const journal = currentJournal(rig)
  const q1 = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'q1', ordinal: 0 },
    asyncQuestionBody(),
    { fence: 1 }
  )
  await journal.appendSubmission({
    clientMessageId: 'answer-async',
    payloadFingerprint: 'answer',
    fence: 1,
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Blue' }] }
  })
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q1.itemId])
  await journal.resolveDispatch({
    clientMessageId: 'answer-async',
    fence: 1,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q1.itemId])
  await journal.resolveDispatch({ clientMessageId: 'answer-async', fence: 1, state: 'unknown' })
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q1.itemId])
  await journal.resolveDispatch({
    clientMessageId: 'answer-async',
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  const q2 = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'q2', ordinal: 0 },
    asyncQuestionBody(),
    { fence: 1 }
  )
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q2.itemId])
})

it('places canonical Stop after its scoped work on replay, without retiring later work or successful turns', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  const journal = currentJournal(rig)
  const turnIdentity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'old-root',
    ordinal: 0
  }
  const turn = await journal.appendItem(
    turnIdentity,
    { kind: 'turn', turnId: 'old-root', state: 'running' },
    { fence: 1 }
  )
  const q1 = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'old-root', ordinal: 1 },
    asyncQuestionBody(),
    { fence: 1, turnScope: { kind: 'turn', turnItemId: turn.itemId } }
  )
  await journal.appendItem(
    turnIdentity,
    { kind: 'turn', turnId: 'old-root', state: 'completed', outcome: 'success' },
    { fence: 1 }
  )
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q1.itemId])
  const nextTurn = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'later-root', ordinal: 0 },
    { kind: 'turn', turnId: 'later-root', state: 'completed', outcome: 'success' },
    { fence: 1 }
  )
  const q2 = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'later-root', ordinal: 1 },
    asyncQuestionBody(),
    { fence: 1, turnScope: { kind: 'turn', turnItemId: nextTurn.itemId } }
  )
  await journal.appendItem(
    turnIdentity,
    { kind: 'turn', turnId: 'old-root', state: 'interrupted', outcome: 'cancellation' },
    { fence: 1 }
  )
  expect(asyncRows(rig).map((row) => row.sourceRowId)).toEqual([q2.itemId])
})

it('publishes a later question through late cancelled-turn output and host replay', async () => {
  rig = await createQueuedMessageTestRig()
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const identity = { provider: 'codex' as const, threadId: THREAD, turnId: 'stopped', ordinal: 0 }
  const old = await journal.appendItem(
    identity,
    { kind: 'turn', turnId: 'stopped', state: 'interrupted', outcome: 'cancellation' },
    { fence: 1 }
  )
  const oldScope = { kind: 'turn' as const, turnItemId: old.itemId }
  await journal.appendItem({ ...identity, ordinal: 1 }, asyncQuestionBody(), {
    fence: 1,
    turnScope: oldScope
  })
  await journal.appendSubmission({
    clientMessageId: 'delivered-between-turns',
    payloadFingerprint: 'Blue',
    fence: 1,
    handoverRecorded: true,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Blue' }] }
  })
  await journal.resolveDispatch({
    clientMessageId: 'delivered-between-turns',
    fence: 1,
    state: 'accepted',
    providerIdentity: null
  })
  const later = await journal.appendItem(
    { ...identity, turnId: 'later' },
    { kind: 'turn', turnId: 'later', state: 'running' },
    { fence: 1 }
  )
  const question = await journal.appendItem(
    { ...identity, turnId: 'later', ordinal: 1 },
    asyncQuestionBody(),
    { fence: 1, turnScope: { kind: 'turn', turnItemId: later.itemId } }
  )
  const live = await observeAsyncQuestions(current, 'late-live')
  try {
    await vi.waitFor(() =>
      expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([question.itemId])
    )
    await journal.appendItem(
      { ...identity, ordinal: 2 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Late completion' }] },
      { fence: 1, turnScope: oldScope }
    )
    await current.host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(live.state().cursor?.sequence).toBe(journal.cursor().sequence))
    expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([question.itemId])
  } finally {
    live.close()
  }
  await current.restartHostProcess()
  const replay = await observeAsyncQuestions(current, 'late-replay')
  try {
    await vi.waitFor(() =>
      expect(replay.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([
        question.itemId
      ])
    )
  } finally {
    replay.close()
  }
})

it.each([40, 400])(
  'bounds Stop-boundary work on a real output publication with %i cancelled turns',
  async (count) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    for (let ordinal = 0; ordinal < count; ordinal++) {
      const identity = {
        provider: 'codex' as const,
        threadId: THREAD,
        turnId: `cancelled-${ordinal}`,
        ordinal: 0
      }
      const turn = await journal.appendItem(
        identity,
        { kind: 'turn', turnId: identity.turnId, state: 'interrupted', outcome: 'cancellation' },
        { fence: 1 }
      )
      await journal.appendItem(
        { ...identity, ordinal: 1 },
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Stopped output' }] },
        { fence: 1, turnScope: { kind: 'turn', turnItemId: turn.itemId } }
      )
    }
    let cursor = 0
    let publications = 0
    const close = await current.host.subscribe({
      id: `stop-perf-${count}`,
      sessionId: SESSION,
      boundedFrames: true,
      readsCurrentRequests: true,
      requestContract: 'agent-session.current-requests.v2',
      emit: (event) => {
        if (event.type !== 'end') {
          cursor =
            event.type === 'batch'
              ? event.batch.cursor.sequence
              : (event.page.liveCursor?.sequence ?? event.page.window.nextCursor.sequence)
          if (event.currentRequests) {
            publications++
          }
        }
      }
    })
    try {
      await current.host.flushStreamedEvents(SESSION)
      let scopes = 0
      const item = journal.item.bind(journal)
      vi.spyOn(journal, 'item').mockImplementation((id) => {
        const value = item(id)
        return (
          value &&
          Object.defineProperty({ ...value }, 'turnScope', {
            enumerable: true,
            get: () => {
              scopes++
              return value.turnScope
            }
          })
        )
      })
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'stream', ordinal: 0 },
        {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Real streaming output' }]
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(cursor).toBe(journal.cursor().sequence))
      expect(scopes).toBeGreaterThan(0)
      expect(scopes).toBeLessThanOrEqual(count * 30)
      const before = publications
      const question = await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'stream', ordinal: 1 },
        asyncQuestionBody(),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(publications).toBeGreaterThan(before))
      expect(asyncRows(current).map((row) => row.sourceRowId)).toEqual([question.itemId])
    } finally {
      close()
    }
  }
)

it.each([40, 400])(
  'does not revisit %i historical submissions on unchanged complete current-request reads',
  async (count) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    for (let i = 0; i < count; i++) {
      await journal.appendSubmission({
        clientMessageId: `historical-${i}`,
        payloadFingerprint: `old-${i}`,
        fence: 1,
        handoverRecorded: true,
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `Old answer ${i}` }] }
      })
      await journal.resolveDispatch({
        clientMessageId: `historical-${i}`,
        fence: 1,
        state: 'accepted',
        providerIdentity: null
      })
    }
    const question = await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'current', ordinal: 1 },
      asyncQuestionBody(),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    let publications = 0
    const close = await current.host.subscribe({
      id: `submissions-cache-${count}`,
      sessionId: SESSION,
      boundedFrames: true,
      readsCurrentRequests: true,
      requestContract: 'agent-session.current-requests.v2',
      emit: (event) => {
        if (event.type !== 'end' && event.currentRequests) {
          publications++
        }
      }
    })
    try {
      await current.host.flushStreamedEvents(SESSION)
      // Join commit-triggered delivery before measuring only unchanged resource reads.
      await current.host.collaboratorsForTests().conversationDelivery.loop.wake(SESSION)
      const projection = currentWork(current).requestProjection(
        SESSION,
        'agent-session.current-requests.v2'
      )
      expect(asyncRows(current).map((row) => row.sourceRowId)).toEqual([question.itemId])
      const submissions = vi.spyOn(journal, 'submissions')
      const visit = vi.spyOn(journal, 'visitItems')
      const serialize = vi.spyOn(JSON, 'stringify')
      for (let reader = 0; reader < 10; reader++) {
        const piece = await current.host.readCurrentRequests(
          { sessionId: SESSION, version: projection.marker.version, cursor: 0 },
          'agent-session.current-requests.v2'
        )
        expect(piece.marker).toBe(projection.marker)
      }
      expect(submissions).not.toHaveBeenCalled()
      expect(visit).not.toHaveBeenCalled()
      expect(serialize.mock.calls.filter(([value]) => value === projection.items)).toHaveLength(0)
      serialize.mockRestore()
      visit.mockRestore()
      submissions.mockRestore()
      const before = publications
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'current', ordinal: 2 },
        { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Delivered answer' }] },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(publications).toBeGreaterThan(before))
      expect(asyncRows(current)).toEqual([])
    } finally {
      close()
    }
  }
)

it.each(['before', 'after'] as const)(
  'isolates cancelled-turn raw IDs with late output %s new work in live publications and replay',
  async (placement) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    const identity = {
      provider: 'codex' as const,
      threadId: THREAD,
      turnId: 'old-raw-x',
      ordinal: 0
    }
    const old = await journal.appendItem(
      identity,
      { kind: 'turn', turnId: identity.turnId, state: 'running' },
      { fence: 1 }
    )
    const oldScope = { kind: 'turn' as const, turnItemId: old.itemId }
    const q1 = await journal.appendItem({ ...identity, ordinal: 1 }, asyncQuestionBody('raw-x'), {
      fence: 1,
      turnScope: oldScope
    })
    const live = await observeAsyncQuestions(current, `causal-raw-${placement}`)
    let q2Id = ''
    try {
      await vi.waitFor(() =>
        expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q1.itemId])
      )
      await journal.appendItem(
        identity,
        { kind: 'turn', turnId: identity.turnId, state: 'interrupted', outcome: 'cancellation' },
        { fence: 1 }
      )
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(live.state().asyncQuestions).toEqual([]))
      const late = async () =>
        journal.appendItem(
          { ...identity, ordinal: 2 },
          {
            ...asyncQuestionBody('raw-x'),
            blocks: [
              ...asyncQuestionBody('raw-x').blocks,
              ...asyncQuestionBody('late-distinct-call').blocks
            ]
          },
          { fence: 1, turnScope: oldScope }
        )
      if (placement === 'before') {
        await late()
      }
      const nextIdentity = { ...identity, turnId: 'new-raw-x' }
      const next = await journal.appendItem(
        nextIdentity,
        { kind: 'turn', turnId: nextIdentity.turnId, state: 'running' },
        { fence: 1 }
      )
      const q2 = await journal.appendItem(
        { ...nextIdentity, ordinal: 1 },
        asyncQuestionBody('raw-x'),
        {
          fence: 1,
          turnScope: { kind: 'turn', turnItemId: next.itemId }
        }
      )
      q2Id = q2.itemId
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() =>
        expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2Id])
      )
      if (placement === 'after') {
        await late()
        await current.host.flushStreamedEvents(SESSION)
        await vi.waitFor(() =>
          expect(live.state().cursor?.sequence).toBe(journal.cursor().sequence)
        )
        expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2Id])
      }
      const owner = journal.messageQuestions()
      const records = owner.repository.current(owner.source).records
      expect(records.filter((row) => row.turnId === old.itemId)).toHaveLength(2)
      expect(
        records
          .filter((row) => row.turnId === old.itemId)
          .every(
            (row) => row.resolution.state === 'cancelled' && row.questions[0].options.length === 2
          )
      ).toBe(true)
    } finally {
      live.close()
    }
    await current.restartHostProcess()
    const replay = await observeAsyncQuestions(current, `causal-raw-replay-${placement}`)
    try {
      await vi.waitFor(() =>
        expect(replay.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2Id])
      )
    } finally {
      replay.close()
    }
  }
)

it('publishes exact-ID shared Cancel without a journal row, historical restatement, provider callback or unseen-Q2 cancellation', async () => {
  rig = await createQueuedMessageTestRig()
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const q1 = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'current', ordinal: 1 },
    asyncQuestionBody('call-Q1'),
    { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  )
  const first = await observeAsyncQuestions(current, 'cancel-first')
  const second = await observeAsyncQuestions(current, 'cancel-second')
  try {
    await vi.waitFor(() =>
      expect(first.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q1.itemId])
    )
    await vi.waitFor(() =>
      expect(second.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q1.itemId])
    )
    const displayed = first.state().asyncQuestions!.map((row) => row.id)
    const q2 = await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'current', ordinal: 2 },
      asyncQuestionBody('call-Q2'),
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await current.host.flushStreamedEvents(SESSION)
    await vi.waitFor(() => expect(second.state().asyncQuestions).toHaveLength(2))
    const cursor = journal.cursor()
    const restate = vi.spyOn(currentWork(current), 'restatedSubmissions')
    const cancelProvider = current.cancelTurn
    const providerCalls = cancelProvider.mock.calls.length
    await current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: displayed }, 'phone-1')
    await vi.waitFor(() =>
      expect(first.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2.itemId])
    )
    await vi.waitFor(() =>
      expect(second.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2.itemId])
    )
    expect(journal.cursor()).toEqual(cursor)
    expect(restate).not.toHaveBeenCalled()
    expect(cancelProvider.mock.calls).toHaveLength(providerCalls)
    await current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: displayed }, 'phone-1')
    await expect(
      current.host.cancelCurrentQuestions(
        { sessionId: SESSION, ids: [...displayed, 'unknown'] },
        'phone-1'
      )
    ).rejects.toThrow('does not belong')
    expect(asyncRows(current).map((row) => row.sourceRowId)).toEqual([q2.itemId])
  } finally {
    first.close()
    second.close()
  }
})

it('keeps canonical rewind successful through failed question settlement, then repairs tombstones and stable outcomes on reopen', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
  const current = rig
  const first = await current.workingSend()
  await current.settleAccepted(first, 'kept')
  const journal = currentJournal(current)
  const kept = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-kept', ordinal: 1 },
    asyncQuestionBody('retained-call'),
    { fence: 1 }
  )
  const displayed = asyncRows(current)
  expect(displayed).toHaveLength(1)
  const keptId = displayed[0].id
  await current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: [keptId] }, 'desktop')
  const pending = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-kept', ordinal: 2 },
    asyncQuestionBody('retained-pending'),
    { fence: 1 }
  )
  const pendingId = asyncRows(current)[0].id
  const target = current.send('rewind this turn')
  expect(await target.result).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await current.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await current.settleAccepted(target.id, 'removed')
  const removed = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-removed', ordinal: 1 },
    asyncQuestionBody('removed-call'),
    { fence: 1 }
  )
  expect(asyncRows(current).map((record) => record.sourceRowId)).toEqual([removed.itemId])
  const owner = journal.messageQuestions()
  const database = openTestJournalHostDatabase(current.root)
  database.db.exec(
    "CREATE TEMP TRIGGER fail_question_settlement BEFORE UPDATE ON message_question_occurrences BEGIN SELECT RAISE(ABORT, 'question storage failure'); END"
  )
  const fields = {
    itemId: agentJournalSubmissionKey(target.id),
    expectedEpoch: journal.cursor().epoch
  }
  expect(
    await current.host.rewind(QUEUED_RIG_CALLER, {
      ...fields,
      envelope: current.envelope(fields, 'agentSession.rewind', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  expect(journal.questionSourceFacts().removed.has(removed.itemId)).toBe(true)
  expect(asyncRows(current)).toEqual([])
  expect(
    owner.repository.current(owner.source).records.find((record) => record.id === keptId)
      ?.resolution.state
  ).toBe('cancelled')
  database.db.exec('DROP TRIGGER fail_question_settlement')
  // Reconstruct from persisted facts with no subscriber or fresh provider event.
  owner.repository.invalidate(messageQuestionSourceId(owner.source))
  current.crashRestartHostProcess()
  await current.host.history({ sessionId: SESSION, direction: 'tail' })
  const reopened = currentJournal(current)
  const view = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (!view || Array.isArray(view)) {
    throw new Error('Expected v2 publication')
  }
  expect(view.asyncQuestions).toEqual([])
  const saved = reopened.messageQuestions()
  const records = saved.repository.current(saved.source).records
  expect(records.find((record) => record.sourceRowId === removed.itemId)?.resolution).toMatchObject(
    { state: 'cancelled', reason: 'source-replaced' }
  )
  expect(records.filter((record) => record.sourceRowId === kept.itemId)).toMatchObject([
    { id: keptId, resolution: { state: 'cancelled' } }
  ])
  expect(records.filter((record) => record.sourceRowId === pending.itemId)).toMatchObject([
    { id: pendingId, resolution: { state: 'resolved' } }
  ])
})

it('preserves clear-floor context and retained outcomes through same-epoch rewind, omitted divider replacement and provider tombstones', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true, rewind: async () => ({ ok: true }) })
  const current = rig
  const started = await current.workingSend()
  await current.settleAccepted(started, 'before-clear')
  const journal = currentJournal(current)
  const earlier = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'turn-before-clear', ordinal: 1 },
    asyncQuestionBody('before-clear-question'),
    { fence: 1 }
  )
  const oldId = asyncRows(current)[0].id
  const clearFields = { command: 'clear' as const }
  expect(
    await current.host.conversationCommand(QUEUED_RIG_CALLER, {
      ...clearFields,
      envelope: current.envelope(
        clearFields,
        'agentSession.conversationCommand',
        hostTestOperationId()
      )
    })
  ).toMatchObject({ ok: true })
  const fence = () => current.store.getRecord(SESSION)!.lease.runtimeFence
  const floor = journal.context.floor()!
  const boundary = current.store.getRecord(SESSION)!.providerContextBoundary!.operationId
  expect(asyncRows(current)).toEqual([])
  const keptIdentity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'turn-kept',
    ordinal: 1
  }
  await journal.appendItem(keptIdentity, asyncQuestionBody('kept-question'), { fence: fence() })
  const keptId = asyncRows(current)[0].id
  await current.host.cancelCurrentQuestions({ sessionId: SESSION, ids: [keptId] }, 'phone')
  const targetId = hostTestOperationId()
  const targetBody = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'remove this answer' }]
  }
  const target = {
    id: targetId,
    result: current.host.send(QUEUED_RIG_CALLER, {
      body: targetBody,
      userSend: true,
      envelope: {
        ...current.envelope({ body: targetBody }, 'agentSession.send', targetId),
        expectedRuntimeFence: fence()
      }
    })
  }
  expect(await target.result).toMatchObject({ ok: true })
  await vi.waitFor(async () =>
    expect((await current.submission(target.id))?.handedOverAt).toBeDefined()
  )
  await current.settleAccepted(target.id, 'removed-after-clear')
  const removedIdentity = {
    provider: 'codex' as const,
    threadId: THREAD,
    turnId: 'turn-removed-after-clear',
    ordinal: 1
  }
  await journal.appendItem(removedIdentity, asyncQuestionBody('removed-question'), {
    fence: fence()
  })
  expect(asyncRows(current)).toHaveLength(1)
  const cut = structuredRewindCut(journal, {
    itemId: agentJournalSubmissionKey(target.id),
    provider: 'codex',
    nativeId: activeProviderContext(current.store.getRecord(SESSION)!).head!.handle.nativeId
  })
  if (!cut) {
    throw new Error('Expected canonical clear-floor rewind cut')
  }
  const fields = { itemId: agentJournalSubmissionKey(target.id), expectedEpoch: floor.epoch }
  expect(
    await current.host.rewind(QUEUED_RIG_CALLER, {
      ...fields,
      envelope: {
        ...current.envelope(fields, 'agentSession.rewind', hostTestOperationId()),
        expectedRuntimeFence: fence()
      }
    })
  ).toMatchObject({ ok: true })
  expect(journal.cursor().epoch).toBe(floor.epoch)
  expect(asyncRows(current)).toEqual([])
  expect(journal.questionSourceFacts().removed.has(agentJournalItemKey(removedIdentity))).toBe(true)
  // Fork replacement uses the actual cut, which deliberately omits the clear divider.
  await journal.replaceEpochItems('handle_forked', fence(), cut.kept)
  expect(journal.context.floor()).toBeNull()
  expect(journal.questionSourceFacts().clearOperationId).toBe(boundary)
  expect(asyncRows(current)).toEqual([])
  const payload = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (!payload || Array.isArray(payload)) {
    throw new Error('Expected v2 payload')
  }
  expect(payload.context.boundary).toBe(agentJournalSubmissionKey(`context-clear:${boundary}`))
  const newIdentity = { ...keptIdentity, ordinal: 2 }
  const next = await journal.appendItem(newIdentity, asyncQuestionBody('new-call-after-rewind'), {
    fence: fence()
  })
  expect(asyncRows(current).map((record) => record.sourceRowId)).toEqual([next.itemId])
  await journal.appendTombstone(newIdentity, { fence: fence() })
  expect(asyncRows(current)).toEqual([])
  current.crashRestartHostProcess()
  await current.host.history({ sessionId: SESSION, direction: 'tail' })
  expect(asyncRows(current)).toEqual([])
  const owner = currentJournal(current).messageQuestions()
  const records = owner.repository.current(owner.source).records
  expect(records.filter((record) => record.sourceRowId === earlier.itemId)).toMatchObject([
    { id: oldId, resolution: { state: 'cancelled' } }
  ])
  expect(
    records.filter((record) => record.sourceRowId === agentJournalItemKey(keptIdentity))
  ).toMatchObject([{ id: keptId, resolution: { state: 'cancelled', reason: 'user' } }])
  expect(records.find((record) => record.sourceRowId === next.itemId)?.resolution).toMatchObject({
    state: 'cancelled',
    reason: 'source-replaced'
  })
})

it.each([10, 100])(
  'does not rebuild %i pending definition values on real unrelated structured output',
  async (count) => {
    rig = await createQueuedMessageTestRig()
    const current = rig
    await current.workingSend()
    const journal = currentJournal(current)
    for (let i = 0; i < count; i++) {
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'pending', ordinal: i },
        asyncQuestionBody(`pending-${i}`),
        { fence: 1 }
      )
    }
    const observed = await observeAsyncQuestions(current, `definitions-${count}`)
    try {
      await vi.waitFor(() => expect(observed.state().asyncQuestions).toHaveLength(count))
      const saved = journal.messageQuestions()
      let reads = 0
      for (const record of saved.repository.current(saved.source).pending) {
        const questions = record.questions
        Object.defineProperty(record, 'questions', {
          configurable: true,
          enumerable: true,
          get: () => {
            reads++
            return questions
          }
        })
      }
      const reconcile = vi.spyOn(saved.repository, 'reconcile')
      const serialize = vi.spyOn(JSON, 'stringify')
      const before = observed.state().asyncQuestions
      for (let i = 0; i < 3; i++) {
        await journal.appendItem(
          { provider: 'codex', threadId: THREAD, turnId: 'output', ordinal: i },
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `unrelated ${i}` }]
          },
          { fence: 1 }
        )
        await current.host.flushStreamedEvents(SESSION)
        await vi.waitFor(() =>
          expect(observed.state().cursor?.sequence).toBe(journal.cursor().sequence)
        )
      }
      expect(reads).toBe(0)
      expect(reconcile).not.toHaveBeenCalled()
      expect(
        serialize.mock.calls.filter(
          ([value]) =>
            typeof value === 'object' &&
            value !== null &&
            ('questions' in value || 'asyncQuestions' in value)
        )
      ).toHaveLength(0)
      expect(observed.state().asyncQuestions).toBe(before)
      serialize.mockRestore()
      await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'new', ordinal: 0 },
        asyncQuestionBody('new-distinct'),
        { fence: 1 }
      )
      await current.host.flushStreamedEvents(SESSION)
      await vi.waitFor(() => expect(observed.state().asyncQuestions).toHaveLength(count + 1))
      expect(reconcile).toHaveBeenCalled()
      expect(observed.state().asyncQuestions).not.toBe(before)
    } finally {
      observed.close()
    }
  }
)
