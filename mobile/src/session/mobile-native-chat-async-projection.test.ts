import { describe, expect, it } from 'vitest'
import { extractMobileAsyncAsk } from './mobile-native-chat-async-ask'
import { extractPendingAsk } from '../../../src/shared/native-chat-ask'
import { sanitizeNativeChatRpcBlock } from '../../../src/main/runtime/rpc/methods/native-chat-rpc-block-sanitize'
import { decodeCodexTranscriptLine } from '../../../src/main/native-chat/transcript-line-decoders-codex'

// Synthetic Codex 0.153.4 rollout envelopes; titles and ids contain no session data.
const input = { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] }
const records = [
  {
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'request_user_input_async',
      call_id: 'ask-1',
      arguments: JSON.stringify(input)
    }
  },
  {
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      item: {
        type: 'AgentMessage',
        id: 'ask-1',
        delivery: 'async',
        phase: 'final_answer',
        questions: input.questions,
        content: [{ type: 'Text', text: 'Which color?\n- Red\n- Blue' }]
      }
    }
  },
  {
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: 'ask-1', output: '{"accepted":true}' }
  }
]

describe('Codex async question mobile projection', () => {
  it('retains the call identity through decoding and the existing mobile RPC sanitizer', () => {
    const messages = records.map((record, i) => {
      const message = decodeCodexTranscriptLine(JSON.stringify(record), `line-${i}`)!
      return {
        ...message,
        blocks: message.blocks.map((block) => sanitizeNativeChatRpcBlock(block, 'mobile'))
      }
    })
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Which color?\n- Red\n- Blue' }]
    })
    expect(extractMobileAsyncAsk(messages)).toEqual({
      asyncCallIds: ['ask-1'],
      questions: [
        {
          question: 'Which color?',
          multiSelect: false,
          options: [{ label: 'Red' }, { label: 'Blue' }]
        }
      ]
    })
    expect(extractPendingAsk(messages)).toBeNull()
  })

  it('does not invent a blocking selector for an object-shaped async call', () => {
    const message = decodeCodexTranscriptLine(
      JSON.stringify({
        type: 'response_item',
        payload: { type: 'function_call', name: 'request_user_input_async', arguments: input }
      }),
      'ask'
    )!
    expect(extractPendingAsk([message])).toBeNull()
  })
})
