import { expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalTurnLifecycle } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'

const LIMIT = "You've hit your 5-hour limit · resets 3pm (America/New_York)"
const limited = (uuid: string) => ({
  type: 'assistant',
  uuid,
  error: 'rate_limit',
  message: { role: 'assistant', content: [{ type: 'text', text: LIMIT }] }
})
const failed = (uuid: string) => ({
  type: 'result',
  subtype: 'success',
  uuid,
  is_error: true,
  result: LIMIT
})

it('keeps a failed turn closed until the next provider cycle, whose wake-up turn it journals', () => {
  const turns = new Map<string, AgentJournalTurnLifecycle>()
  const journal = createClaudeJournalTranslator({
    sink: {
      appendItem: (identity, body) => {
        const turn = readAgentJournalTurn(body)
        if (turn) {
          turns.set(agentJournalItemKey(identity), turn)
        }
      },
      appendTombstone: () => {},
      publish: () => {}
    }
  })
  const frame = (observedAt: number, message: Record<string, unknown>, startsTurn?: true) =>
    journal.handle({
      type: 'message',
      sessionId: 'orca',
      observedAt,
      message: { session_id: 'claude-session', parent_tool_use_id: null, ...message },
      ...(startsTurn ? { startsTurn } : {})
    })
  frame(1_000, { type: 'system', subtype: 'init', uuid: 'init-1' })
  const prompt = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
  frame(1_000, { type: 'user', uuid: 'prompt-1', message: prompt }, true)
  frame(1_100, limited('limit-1'))
  frame(1_200, failed('result-1'))
  // Output after the failed result, before any new cycle, is that turn's, not a new one.
  frame(1_300, limited('late-1'))
  expect([...turns.values()].map((turn) => turn.completedAt)).toEqual([1_200])

  // A background task finished: Claude answers its notification on its own, and that fails too.
  frame(5_000, {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'task-1',
    status: 'completed',
    uuid: 'notice-1'
  })
  frame(5_001, { type: 'system', subtype: 'init', uuid: 'init-2' })
  frame(5_100, limited('limit-2'))
  frame(5_200, failed('result-2'))
  // The wake-up's ending is what tells a later account switch the task was answered.
  expect([...turns.values()].map(({ state, completedAt }) => ({ state, completedAt }))).toEqual([
    { state: 'completed', completedAt: 1_200 },
    { state: 'completed', completedAt: 5_200 }
  ])
})
