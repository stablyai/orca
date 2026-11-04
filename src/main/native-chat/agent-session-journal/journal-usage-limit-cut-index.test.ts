import { expect, it } from 'vitest'
import { applyJournalRow, createJournalReducerState, renderJournalState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import { projectionBase, projectionEpochRow } from './journal-projection-test-support'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import { latestUsageLimitContinueIdentity } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import { agentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../shared/agent-session/failures/agent-session-failure-words'

it('indexed cut matches the public reader through late limits, commands, steers and removal', () => {
  const state = createJournalReducerState('index', projectionEpochRow.epoch)
  applyJournalRow(state, projectionEpochRow)
  let seq = 1
  const item = (
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope = { kind: 'thread' }
  ) => {
    applyJournalRow(state, {
      ...projectionBase(++seq),
      kind: 'item',
      itemId,
      revision: (state.items.get(itemId)?.revision ?? 0) + 1,
      body,
      turnScope
    })
    expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toEqual(
      latestUsageLimitContinueIdentity(renderJournalState(state))
    )
  }
  const limit = (resetsAt?: number): AgentJournalItemBody => ({
    kind: 'status',
    ...agentSessionFailureWords(
      agentSessionFailureFact('usageLimitReached', {
        usageLimit: resetsAt === undefined ? {} : { resetsAt }
      }),
      { surface: 'row' }
    )
  })
  item('failed', { kind: 'turn', turnId: 'failed', state: 'completed', outcome: 'failure' })
  item('limit', limit(), { kind: 'turn', turnItemId: 'failed' })
  item('later-limit', limit(4000), { kind: 'turn', turnItemId: 'failed' })
  item('limit', limit(3000), { kind: 'turn', turnItemId: 'failed' })
  expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toEqual({
    turnItemId: 'failed',
    resetsAt: 3000
  })
  item(
    'steer',
    { kind: 'message', role: 'user', blocks: [] },
    { kind: 'turn', turnItemId: 'failed' }
  )
  item('command-turn', {
    kind: 'turn',
    turnId: 'command',
    state: 'completed',
    userItemId: 'command'
  })
  item('command', { kind: 'message', role: 'user', blocks: [], command: { name: 'context' } })
  expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toBeDefined()
  item('new-request', { kind: 'message', role: 'user', blocks: [] })
  expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toBeUndefined()
  applyJournalRow(state, {
    ...projectionBase(++seq),
    kind: 'tombstone',
    itemId: 'new-request',
    revision: 2
  })
  expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toEqual(
    latestUsageLimitContinueIdentity(renderJournalState(state))
  )
  item(
    'limit',
    { kind: 'status', text: 'No limit', tone: 'info' },
    { kind: 'turn', turnItemId: 'failed' }
  )
  expect(journalInputOrder(state).newestTurn.usageLimitCut.read()).toEqual({
    turnItemId: 'failed',
    resetsAt: 4000
  })
})
