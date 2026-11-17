import { describe, expect, it } from 'vitest'

import { nativeChatLineDecoderForAgent } from './transcript-tail-reader'
// Claude Code 2.1.314 record shapes: a background Agent, reply A, then the task notification that opens reply B's turn.
const TRANSCRIPT = [
  {
    type: 'user',
    uuid: 'prompt',
    origin: { kind: 'human' },
    timestamp: '2026-11-10T16:37:18.178Z',
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Survey the repo in the background' }]
    }
  },
  {
    type: 'assistant',
    uuid: 'spawn',
    parentUuid: 'prompt',
    timestamp: '2026-11-10T16:37:56.536Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Agent',
          input: { description: 'Survey', prompt: 'Survey the repo', run_in_background: true }
        }
      ]
    }
  },
  {
    type: 'user',
    uuid: 'spawn-result',
    parentUuid: 'spawn',
    timestamp: '2026-11-10T16:37:56.647Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'toolu_1',
          content: [{ type: 'text', text: 'Async agent launched successfully.' }]
        }
      ]
    }
  },
  {
    type: 'assistant',
    uuid: 'reply-a',
    parentUuid: 'spawn-result',
    timestamp: '2026-11-10T16:38:11.321Z',
    message: {
      id: 'msg_2',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I started a survey agent.' }]
    }
  },
  {
    type: 'user',
    uuid: 'hand-back',
    parentUuid: 'reply-a',
    promptId: 'prompt-2',
    origin: { kind: 'task-notification', producer: 'session-task', runId: 'run-1' },
    timestamp: '2026-11-10T16:39:53.424Z',
    message: {
      role: 'user',
      content:
        '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Agent "Survey" finished</summary>\n<result>Done.</result>\n</task-notification>'
    }
  },
  {
    type: 'assistant',
    uuid: 'reply-b',
    parentUuid: 'hand-back',
    timestamp: '2026-11-10T16:39:56.981Z',
    message: {
      id: 'msg_3',
      role: 'assistant',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'The survey is back.' }]
    }
  }
]

describe('Claude chat transcript with a background task hand-back', () => {
  it('keeps the tool result a notification delivers to a waiting call', () => {
    const decode = nativeChatLineDecoderForAgent('claude')!
    const mixed = {
      ...TRANSCRIPT[4],
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
