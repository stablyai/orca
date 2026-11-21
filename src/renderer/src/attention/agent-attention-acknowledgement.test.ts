import { describe, expect, it } from 'vitest'
import { isAgentSubjectUnread, type AgentAttentionTurn } from './agent-attention-acknowledgement'

const done = (startedAt: number) => ({ state: 'done' as const, prompt: '', startedAt })
const working = (startedAt: number) => ({ state: 'working' as const, prompt: '', startedAt })

describe('isAgentSubjectUnread', () => {
  it('keeps a viewed turn read across a later session boundary, and the next turn unread', () => {
    const read = (entry: AgentAttentionTurn) =>
      isAgentSubjectUnread(
        { liveTurns: { pane: entry }, acknowledgedTurnStartedAt: { pane: 2_000 } },
        'pane'
      )

    expect(read({ state: 'done', stateStartedAt: 1_000, stateHistory: [] })).toBe(false)
    expect(
      read({
        state: 'done',
        sessionBoundary: true,
        lastCompletionAt: 1_000,
        stateStartedAt: 5_000,
        stateHistory: [done(1_000)]
      })
    ).toBe(false)
    expect(
      read({ state: 'done', stateStartedAt: 9_000, stateHistory: [done(1_000), working(7_000)] })
    ).toBe(true)
    expect(
      read({
        state: 'done',
        sessionBoundary: true,
        lastCompletionAt: 1_000,
        stateStartedAt: 5_000,
        stateHistory: [done(1_000), working(3_000)]
      })
    ).toBe(false)
    expect(
      isAgentSubjectUnread(
        {
          liveTurns: {
            pane: {
              state: 'done',
              sessionBoundary: true,
              lastCompletionAt: 3_000,
              stateStartedAt: 5_000,
              stateHistory: []
            }
          },
          acknowledgedTurnStartedAt: { pane: 2_000 }
        },
        'pane'
      )
    ).toBe(true)
  })
})
