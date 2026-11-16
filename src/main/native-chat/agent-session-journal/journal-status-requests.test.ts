import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'

import { createJournalReducerState } from './projection/journal-reducer'

import { journalInputOrder } from './input-order/journal-input-order'
import { journalDispatchRowBuilder } from './writing/journal-row-builders'
import { readJournalRequestStatus } from './journal-status-requests'

function fixture() {
  return createJournalReducerState('session', 'epoch')
}
function row(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: 1, body, ...extra }
}
const message = (role: 'user' | 'assistant', text: string): AgentJournalRenderItem['body'] => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})

it('selects request order, command dependencies and assistant barriers', () => {
  const state = fixture()
  state.items.set(
    'done',
    row(
      'done',
      10,
      { kind: 'turn', turnId: 'done', state: 'completed', outcome: 'success', completedAt: 100 },
      { sequenceIndex: 2 }
    )
  )
  state.items.set(
    'legacy',
    row(
      'legacy',
      10,
      {
        kind: 'status',
        text: 'Legacy',
        turnLifecycle: { turnId: 'legacy', state: 'interrupted' }
      },
      { sequenceIndex: 1 }
    )
  )
  const command = {
    kind: 'message' as const,
    role: 'assistant' as const,
    command: { name: 'compact' as const },
    blocks: []
  }
  state.items.set('opener', row('opener', 1, command))
  state.items.set(
    'compact',
    row('compact', 11, {
      kind: 'turn',
      turnId: 'compact',
      state: 'completed',
      outcome: 'failure',
      userItemId: 'opener',
      completedAt: 110
    })
  )
  state.items.set('prose', row('prose', 12, message('assistant', 'Root reply')))
  state.items.set(
    'tool-only',
    row('tool-only', 13, { kind: 'message', role: 'assistant', blocks: [] })
  )
  state.items.set(
    'command-result',
    row('command-result', 14, message('assistant', 'Command result'), {
      turnScope: { kind: 'turn', turnItemId: 'compact' }
    })
  )
  state.items.set(
    'child',
    row('child', 90, message('assistant', 'Child reply'), { agentId: 'child' })
  )
  expect(readJournalRequestStatus(state)).toEqual({
    hasRequest: true,
    latestPrompt: '',
    latestRequest: {
      kind: 'turn',
      id: 'done',
      turnState: 'completed',
      outcome: 'success',
      settledAt: 100
    },
    lastAssistantMessage: 'Root reply'
  })
  state.items.set('opener', row('opener', 1, message('user', 'Ordinary opener')))
  expect(readJournalRequestStatus(state)).toMatchObject({
    latestPrompt: 'Ordinary opener',
    latestRequest: { id: 'compact', outcome: 'failure' },
    lastAssistantMessage: 'Command result'
  })
  state.items.set(
    'steer',
    row('steer', 15, message('user', 'Steered prompt'), {
      turnScope: { kind: 'turn', turnItemId: 'done' }
    })
  )
  expect(readJournalRequestStatus(state)).toEqual({
    hasRequest: true,
    latestPrompt: 'Steered prompt',
    latestRequest: {
      kind: 'turn',
      id: 'compact',
      turnState: 'completed',
      outcome: 'failure',
      settledAt: 110
    }
  })
  state.items.set(
    'barrier',
    row('barrier', 16, message('user', 'Unknown request'), { turnScope: { kind: 'unknown' } })
  )
  expect(readJournalRequestStatus(state).latestRequest).toBeNull()
  state.items.set(
    'barrier',
    row('barrier', 16, message('user', 'Thread request'), { turnScope: { kind: 'thread' } })
  )
  expect(readJournalRequestStatus(state).latestRequest?.id).toBe('compact')
})

it('keeps pre-clear existence/prompt, strict acceptance cuts and nonmessage refusals', () => {
  const state = fixture()
  expect(readJournalRequestStatus(state)).toEqual({
    hasRequest: false,
    latestPrompt: '',
    latestRequest: null
  })
  state.items.set('prompt', row('prompt', 1, message('user', 'Keep the prompt')))
  state.items.set(
    'self',
    row('self', 2, {
      kind: 'turn',
      turnId: 'self',
      state: 'completed',
      userItemId: 'self',
      completedAt: 20
    })
  )
  expect(readJournalRequestStatus(state).latestRequest).toMatchObject({
    id: 'self',
    selfStarted: true
  })
  const refusal: AgentJournalSubmission = {
    clientMessageId: 'refused',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: null,
    submittedAt: 3,
    resolvedAt: 30,
    acceptedSequence: 3,
    rejection: { kind: 'writeFailed' }
  }
  state.submissions.set('refused', refusal)
  state.items.set('orca:refused', row('orca:refused', 4, { kind: 'status', text: 'Refused' }))
  const order = journalInputOrder(state)
  const refresh = () =>
    order.afterRow(
      state,
      journalDispatchRowBuilder(() => state, {
        clientMessageId: 'refused',
        state: 'unknown',
        fence: 1
      })(4, 4)
    )
  refresh()
  expect(readJournalRequestStatus(state).latestRequest).toEqual({
    kind: 'refused-send',
    id: 'orca:refused',
    turnState: null,
    outcome: 'failure',
    settledAt: 30
  })
  const clear = {
    kind: 'status' as const,
    text: 'Cleared',
    contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 5 }
  }
  state.items.set('clear', row('clear', 5, clear))
  state.items.set(
    'orca:refused',
    row('orca:refused', 6, { kind: 'status', text: 'Refused after clear' })
  )
  state.submissions.set('refused', { ...refusal, acceptedSequence: 5 })
  refresh()
  expect(readJournalRequestStatus(state)).toEqual({
    hasRequest: true,
    latestPrompt: 'Keep the prompt',
    latestRequest: null
  })
  state.submissions.set('refused', { ...refusal, acceptedSequence: 6 })
  refresh()
  expect(readJournalRequestStatus(state).latestRequest?.id).toBe('orca:refused')
  state.items.set('orca:hidden-clear', row('orca:hidden-clear', 7, clear))
  state.inputs.rejections.set('hidden-clear', { ...refusal, clientMessageId: 'hidden-clear' })
  expect(readJournalRequestStatus(state).latestRequest?.id).toBe('orca:refused')
  state.items.delete('prompt')
  state.items.delete('self')
  state.items.delete('orca:refused')
  state.submissions.delete('refused')
  state.items.set(
    'child-user',
    row('child-user', 8, message('user', 'Provider child'), { agentId: 'child' })
  )
  expect(readJournalRequestStatus(state)).toEqual({
    hasRequest: true,
    latestPrompt: '',
    latestRequest: null
  })
})
