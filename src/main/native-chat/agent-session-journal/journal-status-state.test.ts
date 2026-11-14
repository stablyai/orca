import { expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'

import { createJournalReducerState } from './projection/journal-reducer'

import { readJournalStatusState } from './journal-status-state'

function fixture() {
  return createJournalReducerState('session', 'epoch')
}
function row(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body'],
  extra: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence * 10, body, ...extra }
}

it('uses the current boundary and positional tools, then dates the settled verdict', () => {
  const state = fixture()
  state.items.set(
    'ask',
    row('ask', 1, { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Go' }] })
  )
  const running = {
    kind: 'turn' as const,
    turnId: 'turn',
    state: 'running' as const,
    requestedAt: 100
  }
  state.items.set('turn', row('turn', 2, running))
  state.items.set(
    'call',
    row(
      'call',
      3,
      { kind: 'tool-call', name: 'Read', state: 'running', input: { file_path: 'src/a.ts' } },
      { turnScope: { kind: 'turn', turnItemId: 'other-turn' } }
    )
  )
  state.items.set(
    'diff',
    row('diff', 4, {
      kind: 'diff',
      path: 'src/b.ts',
      patch: { head: '@@\n+x', byteLength: 5, digest: 'd', truncated: false }
    })
  )
  expect(readJournalStatusState(state)).toEqual({
    summary: {
      status: 'working',
      latestPrompt: 'Go',
      toolName: 'Read',
      toolInput: 'src/a.ts',
      statusStartedAt: 100
    },
    latestRequest: {
      kind: 'turn',
      id: 'turn',
      turnState: 'running',
      outcome: null,
      settledAt: undefined
    },
    owesWork: true,
    pendingPromptIds: []
  })
  state.items.set(
    'call',
    row('call', 3, {
      kind: 'tool-call',
      name: 'Read',
      state: 'completed',
      input: { file_path: 'src/a.ts' }
    })
  )
  expect(readJournalStatusState(state).summary).toMatchObject({
    toolName: 'Diff',
    toolInput: 'src/b.ts'
  })
  state.items.set(
    'turn',
    row('turn', 5, { ...running, state: 'completed', outcome: 'success', completedAt: 500 })
  )
  expect(readJournalStatusState(state)).toEqual({
    summary: { status: 'idle', latestPrompt: 'Go', turnOutcome: 'success', statusStartedAt: 500 },
    latestRequest: {
      kind: 'turn',
      id: 'turn',
      turnState: 'completed',
      outcome: 'success',
      settledAt: 500
    },
    owesWork: false,
    pendingPromptIds: []
  })
  state.items.set('turn', row('turn', 5, { ...running, state: 'interrupted', completedAt: 500 }))
  state.items.set(
    'quit',
    row(
      'quit',
      6,
      { kind: 'status', text: 'Quit', orcaStop: { cause: 'quit' } },
      { turnScope: { kind: 'turn', turnItemId: 'turn' }, agentId: 'child' }
    )
  )
  expect(readJournalStatusState(state).summary).toEqual({
    status: 'idle',
    latestPrompt: 'Go',
    turnOutcome: 'cancellation',
    statusStartedAt: 500
  })
})

it('keeps pending timestamps independent of scope and rereads row-free live authority', () => {
  const state = fixture()
  state.items.set(
    'turn',
    row('turn', 1, { kind: 'turn', turnId: 'turn', state: 'running', requestedAt: 100 })
  )
  const question = {
    kind: 'question' as const,
    question: 'Continue?',
    options: [],
    resolution: {
      state: 'pending' as const,
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
  }
  state.items.set('root-first', row('root-first', 3, question, { observedAt: 30 }))
  state.items.set('child', row('child', 4, question, { observedAt: 10, agentId: 'child' }))
  state.items.set('root-second', row('root-second', 5, question, { observedAt: 20 }))
  const current = new Set(['child'])
  const scope = { isCurrentItem: (id: string) => current.has(id), owesSend: () => false }
  expect(readJournalStatusState(state, 1, scope)).toEqual({
    summary: { status: 'attention', latestPrompt: '', statusStartedAt: 20 },
    latestRequest: {
      kind: 'turn',
      id: 'turn',
      turnState: 'running',
      outcome: null,
      settledAt: undefined
    },
    owesWork: false,
    pendingPromptIds: ['child']
  })
  current.clear()
  expect(readJournalStatusState(state, 1, scope)).toMatchObject({
    summary: { status: 'idle' },
    owesWork: false,
    pendingPromptIds: []
  })
  current.add('turn')
  expect(readJournalStatusState(state, 1, scope)).toMatchObject({
    summary: { status: 'working', statusStartedAt: 100 },
    owesWork: true,
    pendingPromptIds: []
  })
})
