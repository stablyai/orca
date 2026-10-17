import { afterEach, expect, it, vi } from 'vitest'
import { pendingJournalAsyncQuestionItems } from './agent-session-pending-async-questions'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { createAgentSessionCurrentRequestsReader } from '../../../shared/agent-session-current-requests-reader'
import { selectPendingAsyncQuestionGroups } from '../../../shared/native-chat-async-questions'
import { selectAgentSessionCurrentRequests } from '../../../shared/agent-session-current-requests'
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
const cleanup: (() => void)[] = []
afterEach(async () => {
  cleanup.splice(0).forEach((close) => close())
  await rig?.dispose()
  rig = undefined
})

it('shares an old async ask across two clients and retires it only after confirmed delivery', async () => {
  rig = await createQueuedMessageTestRig()
  const current = rig
  await current.workingSend()
  const journal = currentJournal(current)
  const attribution = { fence: 1, ownerFence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  const ask = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'async', ordinal: 0 },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [
        {
          type: 'text',
          text: 'Which branch?',
          asyncQuestions: [{ title: 'Which branch?', options: ['main', 'release'] }],
          asyncQuestionId: 'call-1'
        }
      ]
    },
    attribution
  )
  for (let ordinal = 1; ordinal <= 220; ordinal++) {
    await journal.appendItem(
      { provider: 'codex', threadId: THREAD, turnId: 'async', ordinal },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `Working ${ordinal}` }]
      },
      attribution
    )
  }
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'async', ordinal: 221 },
    { kind: 'turn', turnId: 'async', state: 'completed' },
    attribution
  )
  async function connect(id: string) {
    let state = EMPTY_STRUCTURED_AGENT_SESSION
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
    cleanup.push(reader.invalidate)
    cleanup.push(
      await current.host.subscribe({
        id,
        sessionId: SESSION,
        boundedFrames: true,
        readsCurrentRequests: true,
        emit: (event) => {
          state = reduceStructuredAgentSession(state, { type: 'event', event })
          if (event.type !== 'end' && event.currentRequests) {
            reader.observe(event.currentRequests)
          }
        }
      })
    )
    return () => state
  }
  const desktop = await connect('desktop')
  const mobile = await connect('mobile')
  await vi.waitFor(() => {
    for (const read of [desktop, mobile]) {
      expect(selectPendingAsyncQuestionGroups(read())).toEqual([
        {
          key: `${ask.itemId}:0`,
          questions: [{ title: 'Which branch?', options: ['main', 'release'] }]
        }
      ])
      expect(read().items.some((item) => item.itemId === ask.itemId)).toBe(false)
      expect(selectAgentSessionCurrentRequests(read())).toEqual([])
    }
  })
  const marker = desktop().requestMarker!
  const legacy = await current.host.readCurrentRequests({
    sessionId: SESSION,
    version: marker.version
  })
  expect(JSON.parse(legacy.json)).toEqual([])
  const answer = current.send('Which branch?\nrelease')
  await answer.result
  expect(selectPendingAsyncQuestionGroups(desktop())).toHaveLength(1)
  expect(selectPendingAsyncQuestionGroups(mobile())).toHaveLength(1)
  await current.settleAccepted(answer.id, 'answer')
  await vi.waitFor(() => {
    expect(selectPendingAsyncQuestionGroups(desktop())).toEqual([])
    expect(selectPendingAsyncQuestionGroups(mobile())).toEqual([])
  })
  const reopened = await connect('reopened')
  await vi.waitFor(() => expect(selectPendingAsyncQuestionGroups(reopened())).toEqual([]))
})

it('keeps new questions when a pre-clear send is rejected after the context changes', async () => {
  rig = await createQueuedMessageTestRig()
  const sendId = await rig.workingSend()
  const journal = currentJournal(rig)
  const attribution = { fence: 1, ownerFence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'new-context', ordinal: 0 },
    {
      kind: 'status',
      text: 'Context cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 10 }
    },
    attribution
  )
  const ask = await journal.appendItem(
    { provider: 'codex', threadId: THREAD, turnId: 'new-context', ordinal: 1 },
    {
      kind: 'message',
      role: 'assistant',
      blocks: [
        { type: 'text', text: 'Branch?', asyncQuestions: [{ title: 'Branch?', options: ['main'] }] }
      ]
    },
    attribution
  )
  expect(pendingJournalAsyncQuestionItems(journal).map((item) => item.itemId)).toEqual([ask.itemId])
  await rig.settleRejected(sendId, 'Message was not delivered')
  expect((await rig.submission(sendId))?.dispatchState).toBe('rejected')
  expect(pendingJournalAsyncQuestionItems(journal).map((item) => item.itemId)).toEqual([ask.itemId])
})
