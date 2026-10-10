import { randomUUID } from 'node:crypto'

/** A credential-free reply in the real CLI's partial-message cadence. */
export function packagedClaudeChatScenario(providerSessionId: string, partialReplyAckPath: string) {
  const frame = (fields: Record<string, unknown>) => ({
    uuid: randomUUID(),
    session_id: providerSessionId,
    parent_tool_use_id: null,
    ...fields
  })
  const event = (fields: Record<string, unknown>) => frame({ type: 'stream_event', event: fields })
  const message = {
    id: 'packaged-assistant',
    role: 'assistant',
    content: [{ type: 'text', text: 'Packaged server reply.' }]
  }
  return {
    controlResponses: {
      initialize: {
        commands: [],
        models: [{ value: 'sonnet', displayName: 'Sonnet', description: 'Test model' }]
      }
    },
    steps: [
      { awaitUserMessage: true },
      { emit: event({ type: 'message_start', message: { ...message, content: [] } }) },
      {
        emit: event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' }
        })
      },
      {
        emit: event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Packaged server ' }
        })
      },
      { awaitFile: { path: partialReplyAckPath, timeoutMs: 10_000 } },
      {
        emit: event({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'reply.' }
        })
      },
      { emit: frame({ type: 'assistant', message }) },
      { emit: event({ type: 'content_block_stop', index: 0 }) },
      { emit: event({ type: 'message_stop' }) },
      {
        emit: frame({
          type: 'result',
          subtype: 'success',
          is_error: false,
          duration_ms: 150,
          duration_api_ms: 1,
          num_turns: 1,
          result: 'Packaged server reply.',
          total_cost_usd: 0,
          usage: { input_tokens: 1, output_tokens: 4 }
        })
      },
      // Context usage is a control request issued after the result.
      { delayMs: 250 }
    ]
  }
}
