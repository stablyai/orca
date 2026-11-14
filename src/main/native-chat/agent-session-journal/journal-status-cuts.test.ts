import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { createJournalReducerState } from './projection/journal-reducer'
import { renderJournalItems } from './projection/journal-public-read'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalDispatchRowBuilder } from './writing/journal-row-builders'
import { readJournalUsageLimitCut, readJournalOrcaStopCut } from './journal-status-cuts'
import {
  newestStructuredAgentSessionTurn,
  newestStructuredAgentSessionTurnBySequence
} from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { memoryJournalMap } from './journal-memory-collections'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

function fixture() {
  return createJournalReducerState('session', 'epoch')
}
function item(
  id: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId: id, sequence, revision: 1, observedAt: 1, body, ...extra }
}

it('reads the first scoped limit and honours its context boundary', () => {
  const state = fixture()
  state.items.set(
    'failed',
    item(
      'failed',
      10,
      {
        kind: 'turn',
        turnId: 'failed',
        state: 'completed',
        outcome: 'failure',
        completedAt: 100
      },
      { recoveredAt: 200 }
    )
  )
  const scope = { turnScope: { kind: 'turn' as const, turnItemId: 'failed' } }
  const limit = (resetsAt: number) => ({
    kind: 'status' as const,
    ...agentSessionFailureWords(
      agentSessionFailureFact('usageLimitReached', {
        usageLimit: { resetsAt }
      }),
      { surface: 'row' }
    )
  })
  state.items.set(
    'child-limit',
    item('child-limit', 11, limit(300), { ...scope, agentId: 'child' })
  )
  state.items.set('first-limit', item('first-limit', 12, limit(400), scope))
  state.items.set('later-limit', item('later-limit', 13, limit(500), scope))
  expect(readJournalUsageLimitCut(state)).toEqual({
    turnItemId: 'failed',
    resetsAt: 400,
    turnEndedAt: 200
  })
  expect(readJournalUsageLimitCut(state, 12)).toBeNull()

  const command = {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [],
    command: { name: 'compact' as const }
  }
  state.items.set('command', item('command', 14, command))
  state.items.set(
    'command-turn',
    item('command-turn', 15, {
      kind: 'turn',
      turnId: 'compact',
      state: 'completed',
      outcome: 'success',
      userItemId: 'command'
    })
  )
  expect(readJournalUsageLimitCut(state)?.resetsAt).toBe(400)
  state.items.set('command', item('command', 14, { kind: 'message', role: 'user', blocks: [] }))
  expect(readJournalUsageLimitCut(state)).toBeNull()
  state.items.set('command', item('command', 14, command))
  state.items.delete('command-turn')
  state.items.delete('command')
  for (const turnScope of [undefined, { kind: 'thread' as const }, { kind: 'unknown' as const }]) {
    state.items.set(
      'later-user',
      item('later-user', 20, { kind: 'message', role: 'user', blocks: [] }, { turnScope })
    )
    expect(readJournalUsageLimitCut(state)).toBeNull()
  }
  state.items.set(
    'later-user',
    item('later-user', 20, { kind: 'message', role: 'user', blocks: [] }, scope)
  )
  expect(readJournalUsageLimitCut(state)?.resetsAt).toBe(400)
  state.items.delete('later-user')
  const pending: AgentJournalSubmission = {
    clientMessageId: 'pending',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
  state.submissions.set('pending', pending)
  const order = journalInputOrder(state)
  order.afterRow(
    state,
    journalDispatchRowBuilder(() => state, {
      clientMessageId: 'pending',
      state: 'pending',
      fence: 1,
      turnScope: { kind: 'thread' }
    })(21, 1)
  )
  expect(readJournalUsageLimitCut(state)).toBeNull()
})

it('keeps visible and raw boundary order distinct and reads child stop causes', () => {
  const state = fixture()
  state.items.set(
    'orca:running',
    item(
      'orca:running',
      10,
      { kind: 'turn', turnId: 'running', state: 'running' },
      { sequenceIndex: 2 }
    )
  )
  state.items.set(
    'completed',
    item(
      'completed',
      10,
      {
        kind: 'status',
        text: 'Ended',
        turnLifecycle: { turnId: 'completed', state: 'interrupted' }
      },
      { sequenceIndex: 1 }
    )
  )
  const boundary = (raw?: true) => {
    return (
      (raw
        ? newestStructuredAgentSessionTurnBySequence(memoryJournalMap(state.items).values())
        : newestStructuredAgentSessionTurn(renderJournalItems(state))
      )?.turnId ?? null
    )
  }
  expect(boundary()).toBe('running')
  expect(boundary(true)).toBe('completed')
  state.inputs.rejections.set('running', {
    clientMessageId: 'running',
    fence: 1,
    payloadFingerprint: 'fp',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: 1
  })
  expect(boundary()).toBe('completed')
  const scope = {
    turnScope: { kind: 'turn' as const, turnItemId: 'completed' },
    agentId: 'child'
  }
  state.items.set(
    'child-stop',
    item('child-stop', 11, { kind: 'status', text: 'Quit', orcaStop: { cause: 'quit' } }, scope)
  )
  expect(readJournalOrcaStopCut(state)).toEqual({ turnItemId: 'completed', cause: 'quit' })
  state.items.set(
    'clear',
    item('clear', 12, {
      kind: 'status',
      text: 'Cleared',
      contextClear: { operationId: 'clear', afterFence: 1, clearedAt: 1 }
    })
  )
  expect(boundary()).toBeNull()
  expect(readJournalOrcaStopCut(state, 12)).toBeNull()
})
