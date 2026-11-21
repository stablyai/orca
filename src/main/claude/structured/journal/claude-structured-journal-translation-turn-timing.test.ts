import { describe, expect, it } from 'vitest'
import type { AgentSessionPromptSuggestion } from '../../../../shared/agent-session/agent-session-wire'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

function userTurn(uuid: string, observedAt?: number): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    startsTurn: true,
    ...(observedAt === undefined ? {} : { observedAt }),
    message: {
      type: 'user',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'go' }] }
    }
  }
}

const USER_1_KEY = 'claude:claude-session:user-1'

function sessionState(
  state: 'idle' | 'running' | 'requires_action',
  observedAt: number
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    observedAt,
    message: {
      type: 'system',
      subtype: 'session_state_changed',
      state,
      uuid: `ssc-${state}`,
      session_id: 'claude-session'
    }
  }
}

describe('Claude structured turn timing', () => {
  it('settles replaced and resultless turns at the receipt time of the next event', () => {
    const items: AgentJournalItemBody[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => items.push(body),
      appendTombstone: () => {},
      publish: () => {}
    }
    const translator = createClaudeJournalTranslator({ sink })

    translator.handle(userTurn('user-1', 1_000))
    translator.handle(userTurn('user-2', 3_000))
    translator.handle(sessionState('idle', 5_000))

    expect(items.map(readAgentJournalTurn).filter(Boolean)).toEqual([
      { turnId: 'user-1', state: 'running', startedAt: 1_000, userItemId: USER_1_KEY },
      {
        turnId: 'user-1',
        state: 'interrupted',
        outcome: 'superseded',
        startedAt: 1_000,
        completedAt: 3_000,
        userItemId: USER_1_KEY
      },
      {
        turnId: 'user-2',
        state: 'running',
        startedAt: 3_000,
        userItemId: 'claude:claude-session:user-2'
      },
      {
        turnId: 'user-2',
        state: 'completed',
        startedAt: 3_000,
        completedAt: 5_000,
        userItemId: 'claude:claude-session:user-2'
      }
    ])
  })

  it('publishes suggestions between turns and ignores them once the next send starts', () => {
    const suggestions: (AgentSessionPromptSuggestion | null)[] = []
    const journal: AgentJournalItemBody[] = []
    const translator = createClaudeJournalTranslator({
      sink: {
        appendItem: (_identity, body) => journal.push(body),
        appendTombstone: () => {},
        publish: () => {},
        setPromptSuggestion: (suggestion) => suggestions.push(suggestion)
      }
    })
    const handleMessage = (
      message: Record<string, unknown>,
      pending?: { clientMessageId: string }
    ) =>
      translator.handle({
        type: 'message',
        sessionId: 'orca-session',
        message: { session_id: 'claude-session', ...message },
        ...(pending && { startedSend: pending })
      })

    translator.handle(userTurn('user-1'))
    handleMessage({
      type: 'result',
      uuid: 'result-1',
      subtype: 'success',
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      is_error: false,
      stop_reason: 'end_turn',
      terminal_reason: 'completed'
    })
    const beforeSuggestion = journal.slice()
    handleMessage({ type: 'prompt_suggestion', uuid: 's-1', suggestion: '  add a test for it ' })
    handleMessage(
      { type: 'prompt_suggestion', uuid: 's-2', suggestion: 'stale' },
      { clientMessageId: 'send-2' }
    )
    expect(journal).toEqual(beforeSuggestion)

    translator.handle(userTurn('user-2'))
    handleMessage({ type: 'prompt_suggestion', uuid: 's-3', suggestion: 'also stale' })
    expect(suggestions).toEqual([null, { id: 's-1', text: 'add a test for it' }, null])
  })
})
