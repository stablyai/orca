import { expect, it } from 'vitest'
import type { AgentJournalSnapshot } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readPipelineV2Response } from './pipeline-v2-response'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'

const answer = {
  status: 'result',
  outcomeId: 'done',
  summary: 'Queue implemented and tested',
  evidence: { stage: 'implement', changes: ['queue.py implements leases'] }
}
function snapshot(): AgentJournalSnapshot {
  return {
    sessionId: 'session-1',
    cursor: { epoch: 'epoch-1', sequence: 4 },
    submissions: [
      {
        clientMessageId: 'message-1',
        fence: 1,
        payloadFingerprint: 'fingerprint',
        dispatchState: 'accepted',
        providerItemId: 'provider-input',
        reason: null,
        submittedAt: 1,
        resolvedAt: 2
      }
    ],
    items: [
      {
        itemId: agentJournalSubmissionKey('message-1'),
        sequence: 1,
        revision: 1,
        observedAt: 1,
        turnScope: { kind: 'turn', turnItemId: 'turn-1' },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Implement queue' }] }
      },
      {
        itemId: 'turn-1',
        sequence: 2,
        revision: 1,
        observedAt: 4,
        turnScope: { kind: 'thread' },
        body: {
          kind: 'turn',
          turnId: 'provider-turn',
          userItemId: 'provider-input',
          state: 'completed',
          outcome: 'success',
          startedAt: 2,
          completedAt: 4
        }
      },
      {
        itemId: 'answer-1',
        sequence: 3,
        revision: 1,
        observedAt: 3,
        turnScope: { kind: 'turn', turnItemId: 'turn-1' },
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: JSON.stringify(answer) }]
        }
      }
    ]
  }
}
it('accepts only the final root response of the turn opened by the attested send', () => {
  const data = snapshot()
  data.items.push({
    ...data.items[2],
    itemId: 'child-answer',
    sequence: 4,
    agentId: 'child',
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'not a result' }] }
  })
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({
    state: 'completed',
    result: answer,
    observation: {
      requestMessageId: 'message-1',
      clientMessageId: 'message-1',
      turnItemId: 'turn-1',
      responseItemId: 'answer-1',
      category: 'result',
      rawResponse: JSON.stringify(answer),
      rawTruncated: false
    }
  })
  expect(readPipelineV2Response(data, 'other-send')).toMatchObject({ state: 'pending' })
})
it.each([
  ['running', 'success', 'pending'],
  ['interrupted', 'cancellation', 'interrupted'],
  ['completed', 'failure', 'interrupted'],
  ['unverifiable', undefined, 'unverifiable'],
  ['completed', undefined, 'unverifiable']
] as const)('never promotes JSON from a %s turn with verdict %s', (state, outcome, expected) => {
  const data = snapshot()
  data.items[1].body = {
    kind: 'turn',
    turnId: 'provider-turn',
    userItemId: 'provider-input',
    state,
    outcome,
    startedAt: 2,
    completedAt: state === 'running' ? undefined : 4
  }
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: expected })
})
it('holds a result if another user input or an unrelated turn owns the response', () => {
  const data = snapshot()
  const response = data.items[2]
  response.turnScope = { kind: 'turn', turnItemId: 'unrelated-turn' }
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: 'interrupted' })
  response.turnScope = { kind: 'turn', turnItemId: 'turn-1' }
  data.items.push({ ...data.items[0], itemId: 'new-input', sequence: 5 })
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: 'unverifiable' })
})
it('resolves a queued task through the host handover identity', () => {
  const data = snapshot()
  data.submissions[0].queuedMessageId = 'queued-task'
  expect(readPipelineV2Response(data, 'queued-task')).toMatchObject({
    state: 'completed',
    result: answer
  })
})
it.each([
  'Work unfinished',
  '{"status":"result","outcomeId":"done"}',
  JSON.stringify({ ...answer, evidence: { stage: 'implement', changes: [] } })
])('interrupts a normally ended turn without a valid result', (text) => {
  const data = snapshot()
  data.items[2].body = { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: 'interrupted' })
})
it('does not infer completion from a receipt when the provider has not opened its turn yet', () => {
  const data = snapshot()
  data.items = data.items.slice(0, 1)
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: 'pending' })
  data.submissions[0].dispatchState = 'unknown'
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({ state: 'unverifiable' })
})

it('retains quota diagnostics and raw response only from the attested root turn', () => {
  const data = snapshot()
  const turn = data.items[1].body
  if (turn.kind !== 'turn') {
    throw new Error('expected turn')
  }
  turn.outcome = 'failure'
  data.items.push({
    itemId: 'quota',
    sequence: 4,
    revision: 1,
    observedAt: 4,
    turnScope: { kind: 'turn', turnItemId: 'turn-1' },
    body: {
      kind: 'status',
      ...agentSessionFailureWords({ kind: 'usageLimitReached' }, { surface: 'row' })
    }
  })
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({
    state: 'interrupted',
    observation: {
      category: 'quota',
      turnItemId: 'turn-1',
      responseItemId: 'answer-1',
      rawResponse: JSON.stringify(answer)
    }
  })
  data.items[3].turnScope = { kind: 'turn', turnItemId: 'another-turn' }
  expect(readPipelineV2Response(data, 'message-1')).toMatchObject({
    state: 'interrupted',
    observation: { category: 'transport_unknown' }
  })
})
