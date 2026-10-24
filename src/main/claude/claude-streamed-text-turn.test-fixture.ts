// Claude Code 2.1.258 / SDK 0.3.251 capture: only message.id links partial and final frames.
function streamEvent(uuid: string, event: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'stream_event',
      uuid,
      session_id: 'claude-session',
      parent_tool_use_id: null,
      event
    }
  }
}

export function resultFrame(subtype: string, fields: Record<string, unknown>) {
  return {
    type: 'message' as const,
    sessionId: 'orca-session',
    message: {
      type: 'result',
      subtype,
      duration_ms: 1200,
      duration_api_ms: 1100,
      num_turns: 1,
      session_id: 'claude-session',
      uuid: `result-${subtype}`,
      ...fields
    }
  }
}

export function streamedTextTurn(input: {
  messageId: string
  startUuid: string
  finalUuid: string
  chunks: string[]
}) {
  const text = input.chunks.join('')
  return {
    start: [
      streamEvent(`${input.messageId}-message-start`, {
        type: 'message_start',
        message: { id: input.messageId, role: 'assistant', content: [] }
      }),
      streamEvent(input.startUuid, {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      })
    ],
    deltas: input.chunks.map((chunk, index) =>
      streamEvent(`${input.messageId}-delta-${index}`, {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: chunk }
      })
    ),
    final: {
      type: 'message' as const,
      sessionId: 'orca-session',
      message: {
        type: 'assistant',
        uuid: input.finalUuid,
        session_id: 'claude-session',
        parent_tool_use_id: null,
        message: {
          id: input.messageId,
          role: 'assistant',
          content: [{ type: 'text', text }],
          stop_reason: null
        }
      }
    },
    stop: [
      streamEvent(`${input.messageId}-block-stop`, { type: 'content_block_stop', index: 0 }),
      streamEvent(`${input.messageId}-message-delta`, {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' }
      }),
      streamEvent(`${input.messageId}-message-stop`, { type: 'message_stop' }),
      resultFrame('success', {
        is_error: false,
        result: text,
        stop_reason: 'end_turn',
        terminal_reason: 'completed'
      })
    ],
    text
  }
}
