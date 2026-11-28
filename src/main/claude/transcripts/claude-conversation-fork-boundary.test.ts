import type { SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it } from 'vitest'
import { claudeConversationForkBoundary } from './claude-conversation-fork-boundary'

const sessionId = 'session-1'

function row(
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  fields: Record<string, unknown>
): SessionStoreEntry {
  return { type, uuid, parentUuid, sessionId, isSidechain: false, ...fields }
}

function prompt(uuid: string, parentUuid: string | null, text: string): SessionStoreEntry {
  return row(uuid, parentUuid, 'user', { message: { role: 'user', content: text } })
}

function block(
  uuid: string,
  parentUuid: string,
  messageId: string,
  part: Record<string, unknown>,
  apiBlockIndex?: number
): SessionStoreEntry {
  return row(uuid, parentUuid, 'assistant', {
    message: { id: messageId, role: 'assistant', content: [part], stop_reason: 'end_turn' },
    ...(apiBlockIndex === undefined ? {} : { apiBlockIndex })
  })
}

// Claude Code writes one row per content block; only newer builds also record `apiBlockIndex`.
function transcript(withApiBlockIndex: boolean): SessionStoreEntry[] {
  const index = (value: number) => (withApiBlockIndex ? value : undefined)
  return [
    prompt('p1', null, 'first'),
    block('a-thinking', 'p1', 'msg_A', { type: 'thinking', thinking: 'hmm' }, index(0)),
    block('a-read', 'a-thinking', 'msg_A', { type: 'tool_use', id: 't1', name: 'Read' }, index(1)),
    row('a-read-result', 'a-read', 'user', {
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }
    }),
    block(
      'a-grep',
      'a-read-result',
      'msg_A',
      { type: 'tool_use', id: 't2', name: 'Grep' },
      index(2)
    ),
    prompt('p2', 'a-grep', 'second'),
    block('b-thinking', 'p2', 'msg_B', { type: 'thinking', thinking: 'hmm' }, index(0)),
    block('b-text', 'b-thinking', 'msg_B', { type: 'text', text: 'two' }, index(1))
  ]
}

describe('claudeConversationForkBoundary', () => {
  it.each([true, false])(
    'resolves a streamed reply block to its transcript row (apiBlockIndex: %s)',
    (withApiBlockIndex) => {
      const entries = transcript(withApiBlockIndex)
      const through = (uuid: string) =>
        claudeConversationForkBoundary(entries, {
          selectedItemId: uuid,
          settled: true,
          throughMessage: { sessionId, uuid }
        })

      expect(through('block:msg_A:2')).toBe('a-grep')
      expect(() => through('block:msg_A:3')).toThrow(/could not find the saved context/)
      expect(through('block:msg_B:1')).toBe('b-text')
      expect(() => through('block:msg_B:2')).toThrow(/could not find the saved context/)
    }
  )
})
