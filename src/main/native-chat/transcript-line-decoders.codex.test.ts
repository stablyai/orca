import { describe, expect, it } from 'vitest'
import { decodeCodexTranscriptLine } from './transcript-line-decoders-codex'

describe('Codex transcript messages', () => {
  it('keeps the generation id separate from the tool call id', () => {
    for (const type of ['function_call', 'function_call_output']) {
      const message = decodeCodexTranscriptLine(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type,
            name: 'shell',
            call_id: 'call-1',
            arguments: '{}',
            output: 'done',
            internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' }
          }
        }),
        'fallback'
      )
      expect(message?.turnId).toBe('turn-1')
      expect(message?.blocks[0]).toMatchObject({ toolCallId: 'call-1' })
    }
  })

  it('hides provider instructions', () => {
    expect(
      decodeCodexTranscriptLine(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'private instructions' }]
          }
        }),
        'developer'
      )
    ).toBeNull()
  })

  it('preserves subagent turn boundaries without exposing encrypted task payloads', () => {
    expect(
      decodeCodexTranscriptLine(
        JSON.stringify({
          type: 'inter_agent_communication_metadata',
          payload: { trigger_turn: true }
        }),
        'boundary'
      )
    ).toMatchObject({
      id: 'boundary',
      blocks: [],
      subagentEvent: { kind: 'turn-boundary', triggerTurn: true }
    })

    expect(
      decodeCodexTranscriptLine(
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'agent_message',
            id: 'task',
            author: '/root',
            recipient: '/root/worker',
            content: [{ type: 'encrypted_content', encrypted_content: 'secret' }]
          }
        }),
        'fallback'
      )
    ).toMatchObject({
      id: 'task',
      blocks: [],
      subagentEvent: {
        kind: 'agent-message',
        author: '/root',
        recipient: '/root/worker'
      }
    })
  })
})
