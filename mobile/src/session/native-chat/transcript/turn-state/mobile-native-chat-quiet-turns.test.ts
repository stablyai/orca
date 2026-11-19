import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import { mobileNativeChatQuietTurns } from './mobile-native-chat-quiet-turns'

const WORKER: NativeChatMessage['from'] = { kind: 'agent', senders: [], orchestration: null }
const at = (id: string, role: NativeChatMessage['role'], text: string, extra = {}) =>
  ({
    id,
    role,
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text }],
    ...extra
  }) as NativeChatMessage

describe('a quiet turn on the phone', () => {
  it('drops the answer and bar of mail that only changed an item, keeping the mail and its note', () => {
    const rows = [
      at('w1', 'user', 'repro found', { from: WORKER }),
      {
        ...at('n1', 'system', ''),
        blocks: [],
        botItemNote: {
          noteId: 'n1',
          by: 'bot',
          entries: [
            {
              uid: 'i',
              number: 1,
              title: 'Export',
              status: 'working',
              event: 'commented',
              text: 'Yes.'
            }
          ]
        }
      } as NativeChatMessage,
      at('a1', 'assistant', 'NO_REPLY')
    ]
    const quiet = mobileNativeChatQuietTurns(
      rows,
      ['w1', 'w1', 'w1'],
      { w1: { startedAt: 0, thinking: false, workedSeconds: 9 } },
      new Map()
    )
    expect([...quiet.ids]).toEqual(['a1'])
    expect([...quiet.turns]).toEqual(['w1'])
  })
})
