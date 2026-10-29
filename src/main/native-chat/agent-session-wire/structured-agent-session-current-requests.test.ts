import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import { afterEach, expect, it, vi } from 'vitest'
import { selectAgentSessionCurrentRequests } from '../../../shared/agent-session-current-requests'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalResolution
} from '../../../shared/agent-session-journal-types'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { createStructuredAgentSessionEventCoalescer } from '../../../shared/structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from '../../../shared/structured-agent-session-reducer'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD,
  hostTestOperationId
} from './structured-agent-session-host-test-data'
import {
  currentJournal,
  exitWhileSettlementFails
} from './structured-agent-session-leftover-settlement.test-fixture'
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

it('keeps full child requests answerable outside the bounded transcript and clears ended work without a row', async () => {
  rig = await createQueuedMessageTestRig({ restartable: true })
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const parent = { provider: 'codex' as const, threadId: THREAD, turnId: 'parent', ordinal: 0 }
  const attribution = { fence: 1, ownerFence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(
    parent,
    { kind: 'turn', turnId: 'parent', state: 'running' },
    attribution
  )
  const pending: AgentJournalResolution = {
    state: 'pending',
    selectedOptionId: null,
    resolvedBy: null,
    resolvedAt: null
  }
  const approval = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'child', ordinal: 1 },
    {
      kind: 'approval',
      title: 'Run child command?',
      detail: 'inspect all files',
      options: [{ id: 'yes', label: 'Allow child' }],
      resolution: pending
    },
    {
      fence: 1,
      ownerFence: 1,
      agentId: 'child',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  const longChoice = '\\"😀'.repeat(30_000)
  const question = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'child', ordinal: 2 },
    {
      kind: 'question',
      question: 'Choose a path',
      options: [],
      questions: [
        {
          id: 'path',
          question: 'Which?',
          multiSelect: true,
          options: [{ id: 'exact-id', label: longChoice }]
        }
      ],
      resolution: pending
    },
    {
      fence: 1,
      ownerFence: 1,
      agentId: 'child',
      turnScope: AGENT_JOURNAL_THREAD_SCOPE
    }
  )
  await journal.appendItem(
    parent,
    { kind: 'turn', turnId: 'parent', state: 'completed' },
    attribution
  )
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  })
  const reader = createAgentSessionCurrentRequestsReader({
    read: (request) => current.host.readCurrentRequests(request),
    complete: (marker, items) => {
      state = reduceStructuredAgentSession(state, { type: 'requests-complete', marker, items })
    },
    replaceMarker: (marker) => {
      state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker })
    },
    error: (error) => {
      throw error
    }
  })
  const emit = (event: Parameters<typeof coalescer.push>[0]) => {
    expect(Buffer.byteLength(JSON.stringify(event))).toBeLessThan(MOBILE_BRIDGE_MAX_FRAME_BYTES)
    coalescer.push(event)
    if (event.type !== 'end' && event.currentRequests) {
      reader.observe(event.currentRequests)
    }
  }
  const close = await current.host.subscribe({
    id: 'visible',
    sessionId: SESSION,
    boundedFrames: true,
    readsCurrentRequests: true,
    emit
  })
  await vi.waitFor(() =>
    expect(state.currentRequests?.map((item) => item.itemId)).toEqual([
      approval.itemId,
      question.itemId
    ])
  )
  const requestVersion = state.requestMarker?.version
  const cursor = state.cursor
  if (!cursor) {
    throw new Error('expected hydrated cursor')
  }
  close()
  reader.invalidate()
  for (let ordinal = 0; ordinal < 605; ordinal++) {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'root-output', ordinal },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `Root ${ordinal}` }]
      },
      { fence: 1, ownerFence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
  }
  expect(current.host.currentWork(SESSION)?.requestProjection(SESSION).marker.version).toBe(
    requestVersion
  )
  await current.host.subscribe({
    id: 'reopened',
    sessionId: SESSION,
    boundedFrames: true,
    readsCurrentRequests: true,
    cursor,
    emit
  })
  coalescer.flush()
  await vi.waitFor(() =>
    expect(state.requestAuthority?.version).toEqual(state.requestMarker?.version)
  )
  expect(state.items.length).toBeLessThanOrEqual(200)
  expect(
    state.items.some((item) => item.itemId === approval.itemId || item.itemId === question.itemId)
  ).toBe(false)
  const prompts = selectAgentSessionCurrentRequests(state)
  expect(prompts.map((item) => item.itemId)).toEqual([approval.itemId, question.itemId])
  expect(prompts[1]?.body).toMatchObject({
    questions: [
      {
        id: 'path',
        multiSelect: true,
        options: [{ id: 'exact-id', label: longChoice }]
      }
    ]
  })
  const answer = {
    itemId: approval.itemId,
    expectedRevision: approval.revision,
    optionId: 'yes'
  }
  expect(
    await current.host.respondToPrompt(QUEUED_RIG_CALLER, {
      ...answer,
      kind: 'approval',
      envelope: current.envelope(answer, 'agentSession.respondTo:approval', hostTestOperationId())
    })
  ).toMatchObject({ ok: true })
  await vi.waitFor(() =>
    expect(state.currentRequests?.map((item) => item.itemId)).toEqual([question.itemId])
  )
  const beforeExit = journal.cursor()
  await exitWhileSettlementFails(current)
  await vi.waitFor(() => expect(state.currentRequests).toEqual([]))
  expect(journal.cursor()).toEqual(beforeExit)
  expect(selectAgentSessionCurrentRequests(state)).toEqual([])
  reader.invalidate()
  coalescer.dispose()
})

it('publishes async controls beyond both history retention limits without rescanning on unchanged reads', async () => {
  rig = await createQueuedMessageTestRig()
  await rig.workingSend()
  const journal = currentJournal(rig)
  const question = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'async', ordinal: 0 },
    asyncQuestionBody(),
    { fence: 1 }
  )
  for (let ordinal = 0; ordinal < 4100; ordinal++) {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'output', ordinal },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Still working' }] },
      { fence: 1 }
    )
  }
  let state = EMPTY_STRUCTURED_AGENT_SESSION
  const host = rig.host
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
    id: 'async-current',
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
  await vi.waitFor(() =>
    expect(state.asyncQuestions?.map((row) => row.sourceRowId)).toEqual([question.itemId])
  )
  expect(state.items.some((item) => item.itemId === question.itemId)).toBe(false)
  const marker = state.requestMarker!
  const visits = vi.spyOn(journal, 'visitItems')
  const first = await host.readCurrentRequests(
    { sessionId: SESSION, version: marker.version },
    marker.contract
  )
  const second = await host.readCurrentRequests(
    { sessionId: SESSION, version: marker.version },
    marker.contract
  )
  expect(second).toEqual(first)
  expect(visits).not.toHaveBeenCalled()
  reader.invalidate()
  close()
}, 30_000)

import { codexItemBody } from '../../codex/codex-structured-item-translation'
import { currentWork } from './structured-agent-session-leftover-settlement.test-fixture'

function asyncQuestionBody() {
  const body = codexItemBody({
    type: 'agentMessage',
    id: 'provider-call',
    text: 'Which color?',
    delivery: 'async',
    questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }]
  })
  if (!body) {
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
