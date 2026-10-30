import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import { afterEach, expect, it, vi } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'
import { currentJournal } from './structured-agent-session-leftover-settlement.test-fixture'
import {
  createQueuedMessageTestRig,
  type QueuedMessageTestRig
} from './structured-agent-session-queued-message-rig.test-fixture'

let rig: QueuedMessageTestRig | undefined
afterEach(async () => {
  await rig?.dispose()
  rig = undefined
  vi.restoreAllMocks()
})

import { codexItemBody } from '../../codex/codex-structured-item-translation'
import { currentWork } from './structured-agent-session-leftover-settlement.test-fixture'

function asyncQuestionBody(id = 'provider-call') {
  const body = codexItemBody({
    type: 'agentMessage',
    id,
    text: 'Which color?',
    delivery: 'async',
    questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }]
  })
  if (body?.kind !== 'message') {
    throw new Error('expected recorded async question')
  }
  return body
}
function asyncRows(current: QueuedMessageTestRig) {
  const payload = currentWork(current).requestProjection(
    SESSION,
    'agent-session.current-requests.v2'
  ).items
  if (Array.isArray(payload)) {
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

async function observeAsyncQuestions(current: QueuedMessageTestRig, id: string) {
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const host = current.host
  const reader = createAgentSessionCurrentRequestsReader({
    read: (request) => host.readCurrentRequests(request, 'agent-session.current-requests.v2'),
    complete: (marker, items, payload) => {
      state = reduceStructuredAgentSession(state, {
        type: 'requests-complete',
        marker,
        items,
        payload
      })
    },
    replaceMarker: (marker) => {
      state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker })
    },
    error: (error) => {
      throw error
    }
  })
  const close = await host.subscribe({
    id,
    sessionId: SESSION,
    boundedFrames: true,
    readsCurrentRequests: true,
    requestContract: 'agent-session.current-requests.v2',
    emit: (event) => {
      state = reduceStructuredAgentSession(state, { type: 'event', event })
      if (event.type !== 'end' && event.currentRequests) {
        reader.observe(event.currentRequests)
      }
    }
  })
  return {
    state: () => state,
    close: () => {
      close()
      reader.invalidate()
    }
  }
}

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
    await current.host.flushAllStreamedEvents()
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
          cursor = event.cursor.sequence
          if (event.currentRequests) {
            publications++
          }
        }
      }
    })
    try {
      await current.host.flushAllStreamedEvents()
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
      await current.host.flushAllStreamedEvents()
      await vi.waitFor(() => expect(cursor).toBe(journal.cursor().sequence))
      expect(scopes).toBeGreaterThan(count)
      expect(scopes).toBeLessThanOrEqual(count * 30)
      const before = publications
      const question = await journal.appendItem(
        { provider: 'codex', threadId: THREAD, turnId: 'stream', ordinal: 1 },
        asyncQuestionBody(),
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
      await current.host.flushAllStreamedEvents()
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
      await current.host.flushAllStreamedEvents()
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
      await current.host.flushAllStreamedEvents()
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
      await current.host.flushAllStreamedEvents()
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
      await current.host.flushAllStreamedEvents()
      await vi.waitFor(() =>
        expect(live.state().asyncQuestions?.map((row) => row.sourceRowId)).toEqual([q2Id])
      )
      if (placement === 'after') {
        await late()
        await current.host.flushAllStreamedEvents()
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
    await current.host.flushAllStreamedEvents()
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
