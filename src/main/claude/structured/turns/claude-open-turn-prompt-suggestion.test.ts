import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionPromptSuggestion } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { createClaudeJournalTranslator } from '../journal/claude-structured-journal-translation'
import type { ClaudeStructuredSessionEvent } from '../lifecycle/claude-structured-session-event'

function message(
  body: Record<string, unknown>,
  extra: Partial<Extract<ClaudeStructuredSessionEvent, { type: 'message' }>> = {}
): ClaudeStructuredSessionEvent {
  return {
    type: 'message',
    sessionId: 'orca-session',
    message: { session_id: 'claude-session', ...body },
    ...extra
  }
}

const userTurn = (uuid: string): ClaudeStructuredSessionEvent =>
  message(
    {
      type: 'user',
      uuid,
      parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text: 'parse ints' }] }
    },
    { startsTurn: true }
  )

const result = (uuid: string): ClaudeStructuredSessionEvent =>
  message({
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

const suggestion = (
  uuid: string,
  text: string,
  extra?: Partial<Extract<ClaudeStructuredSessionEvent, { type: 'message' }>>
): ClaudeStructuredSessionEvent =>
  message({ type: 'prompt_suggestion', suggestion: text, uuid }, extra)

function translated() {
  const published: (AgentSessionPromptSuggestion | null)[] = []
  const appendItem = vi.fn()
  const sink: StructuredAgentSessionEventSink = {
    appendItem,
    appendTombstone: vi.fn(),
    publish: vi.fn(),
    setPromptSuggestion: (next) => published.push(next)
  }
  return { translator: createClaudeJournalTranslator({ sink }), published, appendItem }
}

describe("Claude's suggested next prompt", () => {
  it('is published off the journal after a result and cleared when the next turn opens', () => {
    const { translator, published, appendItem } = translated()
    translator.handle(userTurn('user-1'))
    translator.handle(result('result-1'))
    const rows = appendItem.mock.calls.length

    translator.handle(suggestion('s-1', '  add a test for it '))
    expect(published).toEqual([null, { id: 's-1', text: 'add a test for it' }])
    expect(appendItem).toHaveBeenCalledTimes(rows)

    translator.handle(userTurn('user-2'))
    expect(published.at(-1)).toBeNull()
  })

  it('drops a guess that arrives once the next prompt is already on its way', () => {
    const { translator, published } = translated()
    translator.handle(userTurn('user-1'))
    translator.handle(result('result-1'))
    translator.handle(suggestion('s-1', 'stale', { startedSend: { clientMessageId: 'send-2' } }))

    translator.handle(userTurn('user-2'))
    translator.handle(suggestion('s-2', 'also stale'))

    expect(published).toEqual([null, null])
  })
})
