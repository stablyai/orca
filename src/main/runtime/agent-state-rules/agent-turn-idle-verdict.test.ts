import { describe, expect, it } from 'vitest'
import {
  AGENT_START_GRACE_MS,
  judgeIdleAgentTurn,
  type AgentTurnStatusRow
} from './agent-turn-idle-verdict'

const SENT_AT = 10_000

function judge(rows: AgentTurnStatusRow[], tail: string[] = [], now = SENT_AT + 1) {
  return judgeIdleAgentTurn(
    { rows, sentAt: SENT_AT, tail, readAgentCommands: () => ['claude'] },
    now
  )
}

describe('judgeIdleAgentTurn', () => {
  it('completes on a done reached since the turn was sent', () => {
    expect(judge([{ state: 'done', stateStartedAt: SENT_AT }])).toEqual({ kind: 'completed' })
  })

  it('waits past a previous turn, a connect-time or a resume-only done', () => {
    expect(judge([{ state: 'done', stateStartedAt: SENT_AT - 1 }])).toEqual({ kind: 'wait' })
    expect(judge([{ state: 'done', stateStartedAt: SENT_AT, sessionBoundary: true }])).toEqual({
      kind: 'wait'
    })
    expect(judge([{ state: 'done', stateStartedAt: SENT_AT, providerSessionOnly: true }])).toEqual({
      kind: 'wait'
    })
  })

  it('fails when the shell refused the agent command', () => {
    expect(judge([], ['zsh: command not found: claude'])).toEqual({
      kind: 'failed',
      missingCommandLine: 'zsh: command not found: claude'
    })
  })

  it('believes an idle pane only for an agent that never reported, after the grace', () => {
    expect(judge([], [], SENT_AT + AGENT_START_GRACE_MS)).toEqual({ kind: 'completed' })
    expect(judge([], [], SENT_AT + AGENT_START_GRACE_MS - 1)).toEqual({ kind: 'wait' })
    expect(judge([{ state: 'working', stateStartedAt: SENT_AT }], [], SENT_AT * 100)).toEqual({
      kind: 'wait'
    })
  })
})
