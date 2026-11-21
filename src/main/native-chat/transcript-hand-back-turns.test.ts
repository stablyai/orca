import { describe, expect, it } from 'vitest'

import { nativeChatLineDecoderForAgent } from './transcript-decoding/native-chat-line-decoder'

describe('Claude chat transcript with a background task hand-back', () => {
  it('keeps the tool result a notification delivers to a waiting call', () => {
    const decode = nativeChatLineDecoderForAgent('claude')!
    const mixed = {
      type: 'user',
      uuid: 'hand-back',
      parentUuid: 'reply-a',
      promptId: 'prompt-2',
      origin: { kind: 'task-notification', producer: 'session-task', runId: 'run-1' },
      timestamp: '2026-11-10T16:39:53.424Z',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '<task-notification>\n<task-id>t1</task-id>\n</task-notification>'
          },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'real result' }
        ]
      }
    }
    expect(decode(JSON.stringify(mixed), 'line-0')).toMatchObject({
      role: 'tool',
      blocks: [{ type: 'tool-result', output: 'real result' }]
    })
  })
})
