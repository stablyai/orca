import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { AgentConversationCopyError } from '../../native-chat/conversation-adoption/agent-conversation-copy-error'
import {
  claudeConversationForkBoundary,
  type ClaudeForkCheckpoint
} from './claude-conversation-fork-boundary'

const SESSION_ID = 'session-1'

function userPrompt(): Record<string, unknown> {
  return {
    type: 'user',
    uuid: 'u-prompt',
    parentUuid: null,
    sessionId: SESSION_ID,
    message: {
      id: 'msg_P',
      role: 'user',
      content: [{ type: 'text', text: 'hello' }]
    }
  }
}

function assistantRow(
  uuid: string,
  parentUuid: string,
  block: Record<string, unknown>,
  apiBlockIndex?: number
): Record<string, unknown> {
  return {
    type: 'assistant',
    uuid,
    parentUuid,
    sessionId: SESSION_ID,
    ...(apiBlockIndex === undefined ? {} : { apiBlockIndex }),
    message: {
      id: 'msg_X',
      role: 'assistant',
      content: [block],
      stop_reason: 'end_turn'
    }
  }
}

function checkpointFor(blockId: string): ClaudeForkCheckpoint {
  return {
    selectedItemId: blockId,
    settled: true,
    throughMessage: { sessionId: SESSION_ID, uuid: blockId }
  }
}

describe('claudeConversationForkBoundary', () => {
  it('maps a Claude Code 2.0.42 transcript row without apiBlockIndex by block order (see #48148)', () => {
    // Claude Code 2.0.42 writes one transcript row per content block. The
    // rows share message.id and carry no apiBlockIndex, so the text block of
    // a thinking-then-text reply is block:msg_X:1. Before the fix this threw
    // AgentConversationCopyError ("Claude could not find the saved context").
    const entries = [
      userPrompt(),
      assistantRow('u-thinking', 'u-prompt', { type: 'thinking', thinking: 'let me think' }),
      assistantRow('u-text', 'u-thinking', { type: 'text', text: 'hello' })
    ] as unknown as SessionStoreEntry[]
    expect(claudeConversationForkBoundary(entries, checkpointFor('block:msg_X:1'))).toBe('u-text')
  })

  it('still maps a 2.1.x transcript row that carries apiBlockIndex', () => {
    const entries = [
      userPrompt(),
      assistantRow('u-thinking', 'u-prompt', { type: 'thinking', thinking: 'let me think' }, 0),
      assistantRow('u-text', 'u-thinking', { type: 'text', text: 'hello' }, 1)
    ] as unknown as SessionStoreEntry[]
    expect(claudeConversationForkBoundary(entries, checkpointFor('block:msg_X:1'))).toBe('u-text')
  })

  it('throws when no row matches the requested block', () => {
    const entries = [
      userPrompt(),
      assistantRow('u-thinking', 'u-prompt', { type: 'thinking', thinking: 'let me think' }),
      assistantRow('u-text', 'u-thinking', { type: 'text', text: 'hello' })
    ] as unknown as SessionStoreEntry[]
    expect(() =>
      claudeConversationForkBoundary(entries, checkpointFor('block:msg_X:9'))
    ).toThrow(AgentConversationCopyError)
  })
})
