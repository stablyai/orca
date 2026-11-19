import { describe, expect, it } from 'vitest'
import { isAgentSubjectUnread, type AgentAttentionTurn } from './agent-attention-acknowledgement'

describe('isAgentSubjectUnread', () => {
  it('keeps a viewed turn read across a later session boundary, and the next turn unread', () => {
    const viewedTurn = { state: 'done', stateStartedAt: 1_000, stateHistory: [] }
    const boundary = {
      state: 'done',
      sessionBoundary: true,
      stateStartedAt: 5_000,
      stateHistory: [{ startedAt: 1_000 }]
    }
    const nextTurn = {
      state: 'done',
      stateStartedAt: 9_000,
      stateHistory: [{ startedAt: 1_000 }, { startedAt: 7_000 }]
    }
    const read = (entry: AgentAttentionTurn) =>
      isAgentSubjectUnread(
        { liveTurns: { pane: entry }, acknowledgedTurnStartedAt: { pane: 2_000 } },
        'pane'
      )

    expect(read(viewedTurn)).toBe(false)
    expect(read(boundary)).toBe(false)
    expect(read(nextTurn)).toBe(true)
  })
})
