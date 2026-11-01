import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from './structured/journal/claude-structured-journal-translation'

function frame(message: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: { session_id: 'claude-session', ...message }
  }
}

function chat(type: 'assistant' | 'user', uuid: string, text: string) {
  return {
    ...frame({
      type,
      uuid,
      parent_tool_use_id: null,
      message: { role: type, content: [{ type: 'text', text }] }
    }),
    ...(type === 'user' ? { startsTurn: true as const } : {})
  }
}

const done = (uuid: string) =>
  frame({
    type: 'result',
    subtype: 'success',
    uuid,
    duration_ms: 1200,
    duration_api_ms: 1100,
    num_turns: 1,
    is_error: false,
    stop_reason: 'end_turn',
    terminal_reason: 'completed'
  })

const suggestion = (text: string) =>
  frame({ type: 'prompt_suggestion', suggestion: text, uuid: `s-${text}` })

describe('Claude prompt suggestions', () => {
  it('publishes a suggestion off the journal and clears it whenever a turn opens', () => {
    const rows: AgentJournalItemBody[] = []
    const suggestions: (string | null)[] = []
    const sink: StructuredAgentSessionEventSink = {
      appendItem: (_identity, body) => rows.push(body),
      appendTombstone: vi.fn(),
      publish: vi.fn(),
      setPromptSuggestion: (next) => suggestions.push(next)
    }
    const translator = createClaudeJournalTranslator({ sink })

    translator.handle(chat('user', 'user-1', 'parse ints'))
    translator.handle(chat('assistant', 'assistant-1', 'done'))
    translator.handle(done('result-1'))
    // The first turn clears too: a relaunch may inherit one the host still retains.
    expect(suggestions).toEqual([null])
    const journaled = rows.length
    translator.handle(suggestion('add a test'))
    expect(suggestions).toEqual([null, 'add a test'])
    expect(rows).toHaveLength(journaled)

    translator.handle(chat('user', 'user-2', 'also floats'))
    translator.handle(chat('assistant', 'assistant-2', 'working'))
    // A suggestion for the turn before this one is stale once it runs.
    translator.handle(suggestion('stale'))
    translator.handle(done('result-2'))
    expect(suggestions).toEqual([null, 'add a test', null])
  })
})
