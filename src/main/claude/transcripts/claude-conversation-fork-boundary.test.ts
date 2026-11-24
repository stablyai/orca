import { expect, it } from 'vitest'
import {
  claudeConversationForkBoundary,
  type ClaudeForkCheckpoint
} from './claude-conversation-fork-boundary'
import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'

const SESSION = '00000000-0000-4000-8000-000000000001'

// Claude Code 2.0.42: one transcript row per content block, and no apiBlockIndex on any of them.
function legacyReply(): SessionStoreEntry[] {
  const base = {
    sessionId: SESSION,
    session_id: SESSION,
    cwd: '/workspace',
    version: '2.0.42',
    type: 'assistant'
  }
  return [
    {
      ...base,
      type: 'user',
      uuid: 'u-prompt',
      parentUuid: null,
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    },
    {
      ...base,
      uuid: 'u-thinking',
      parentUuid: 'u-prompt',
      message: {
        id: 'msg_X',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: 'considering' }],
        stop_reason: 'end_turn'
      }
    },
    {
      ...base,
      uuid: 'u-text',
      parentUuid: 'u-thinking',
      message: {
        id: 'msg_X',
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
        stop_reason: 'end_turn'
      }
    }
  ] as SessionStoreEntry[]
}

function checkpoint(through: string): ClaudeForkCheckpoint {
  return {
    selectedItemId: through,
    settled: true,
    throughMessage: { sessionId: SESSION, uuid: through }
  }
}

it('lands the fork boundary on a 2.0.x text row that carries no apiBlockIndex', () => {
  // The streamed text block identifies itself as block:msg_X:1; only block order can map it back.
  expect(claudeConversationForkBoundary(legacyReply(), checkpoint('block:msg_X:1'))).toBe('u-text')
})

it('still rejects a through id that matches no block', () => {
  expect(() => claudeConversationForkBoundary(legacyReply(), checkpoint('block:msg_Y:0'))).toThrow(
    'Claude could not find the saved context for this response'
  )
})
