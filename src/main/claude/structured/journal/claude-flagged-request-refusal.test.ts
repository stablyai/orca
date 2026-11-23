import { expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import { readAgentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { createClaudeJournalTranslator } from './claude-structured-journal-translation'

const REFUSAL_TEXT =
  "API Error: Claude Opus 5.5's safeguards flagged this message (https://www.anthropic.com/legal/aup). Claude can't respond to this message with Opus 5.5."

// What the CLI sends when a flagged request runs on no other model, trimmed to what is read.
const FLAGGED_TURN: Record<string, unknown>[] = [
  {
    type: 'user',
    uuid: 'user-1',
    session_id: 'claude-session',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'scan this host' }] }
  },
  {
    type: 'system',
    subtype: 'model_refusal_no_fallback',
    original_model: 'claude-opus-5-5',
    request_id: 'req_1',
    api_refusal_category: 'cyber',
    refused_user_message_uuid: 'user-1',
    content: '',
    uuid: 'no-fallback-1',
    session_id: 'claude-session'
  },
  {
    type: 'assistant',
    uuid: 'assistant-1',
    session_id: 'claude-session',
    parent_tool_use_id: null,
    user_message_uuid: 'user-1',
    error: 'invalid_request',
    message: {
      id: 'msg_1',
      role: 'assistant',
      model: '<synthetic>',
      stop_reason: 'refusal',
      content: [{ type: 'text', text: REFUSAL_TEXT }]
    }
  },
  {
    type: 'result',
    subtype: 'success',
    is_error: true,
    result: REFUSAL_TEXT,
    user_message_uuid: 'user-1',
    uuid: 'result-1',
    session_id: 'claude-session'
  }
]

it('ends a flagged turn with one error naming the setting when switching is off', () => {
  const bodies: AgentJournalItemBody[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (_identity, body) => bodies.push(body),
    appendTombstone: vi.fn(),
    publish: vi.fn()
  }
  const translator = createClaudeJournalTranslator({ sink, stopsOnFlaggedRequest: () => true })

  FLAGGED_TURN.forEach((message, index) =>
    translator.handle({
      type: 'message',
      sessionId: 'orca-session',
      message,
      ...(index === 0 ? { startsTurn: true } : {})
    })
  )

  const errors = bodies.filter((body) => body.kind === 'status' && body.tone === 'error')
  expect(errors).toHaveLength(1)
  expect(readAgentSessionFailureFact(errors[0]?.kind === 'status' && errors[0].failure)).toEqual(
    expect.objectContaining({ kind: 'flaggedRequestNotSwitched' })
  )
  expect(bodies.some((body) => body.kind === 'message' && body.role === 'assistant')).toBe(false)
})
