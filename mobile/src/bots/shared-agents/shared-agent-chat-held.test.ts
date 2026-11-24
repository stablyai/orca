// A teammate's held messages, as the phone draws them: Waiting, then nothing once delivered (the host's
// row stands for it), or Not sent; and a new chat only its held messages name lists until its host has it.
import { describe, expect, it } from 'vitest'
import { agentJournalSubmissionKey } from '../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { BotChatTreeChat } from '../../../../src/shared/bots/bot-chat-tree'
import type { SharedBotHeldView } from '../../../../src/shared/bots/shared-bot-hosts'
import {
  sharedAgentChatHeld,
  sharedAgentChats,
  sharedAgentChatTranscriptHeld
} from './shared-agent-chat-held'

const held = (
  clientMessageId: string,
  sessionId: string,
  state: SharedBotHeldView['state'],
  sentAt: number
): SharedBotHeldView => ({
  clientMessageId,
  sessionId,
  text: `text ${clientMessageId}`,
  attachments: [],
  sentAt,
  state
})

const chat = (chatId: string, lastActiveAt: number): BotChatTreeChat => ({
  chatId,
  title: chatId,
  origin: 'side',
  live: 'idle',
  lastActiveAt,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0
})

const NEW_CHAT = 'shared-new-00000000-0000-4000-8000-000000000001'

describe('a shared agent’s held messages on the phone', () => {
  it('lists a new chat only its held messages name, newest first, and drops it once delivered', () => {
    const chats = [chat('chat-1', 10)]
    expect(
      sharedAgentChats(chats, [held('m1', NEW_CHAT, 'waiting', 20)]).map((c) => c.chatId)
    ).toEqual([NEW_CHAT, 'chat-1'])
    expect(sharedAgentChats(chats, [held('m1', NEW_CHAT, 'delivered', 20)])).toEqual(chats)
    // A held message in a chat the host lists adds no row of its own.
    expect(sharedAgentChats(chats, [held('m1', 'chat-1', 'waiting', 20)])).toEqual(chats)
    // Nor does one in a chat the host hasn't listed yet (an offline page's first read).
    expect(sharedAgentChats(chats, [held('m1', 'chat-2', 'waiting', 20)])).toEqual(chats)
  })

  it('marks a chat by its latest held message that has not landed', () => {
    const messages = [held('m1', 'chat-1', 'delivered', 1), held('m2', 'chat-1', 'not_sent', 2)]
    expect(sharedAgentChatHeld(messages, 'chat-1')).toEqual({
      state: 'not_sent',
      clientMessageId: 'm2',
      text: 'text m2'
    })
    expect(sharedAgentChatHeld([held('m1', 'chat-1', 'delivered', 1)], 'chat-1')).toBeNull()
    expect(sharedAgentChatHeld(messages, 'chat-2')).toBeNull()
  })

  it('draws a chat’s waiting and refused messages under the host’s row keys, and none delivered', () => {
    const shown = sharedAgentChatTranscriptHeld(
      [
        held('m1', 'chat-1', 'delivered', 1),
        held('m2', 'chat-1', 'waiting', 2),
        held('m3', 'chat-1', 'not_sent', 3),
        held('m4', 'chat-2', 'waiting', 4)
      ],
      'chat-1'
    )
    expect(shown.pending.map((item) => item.id)).toEqual([
      agentJournalSubmissionKey('m2'),
      agentJournalSubmissionKey('m3')
    ])
    expect([...shown.words.values()]).toEqual([
      { state: 'waiting', clientMessageId: 'm2' },
      { state: 'not_sent', clientMessageId: 'm3' }
    ])
    expect(shown.readable).toBe(true)
    expect(sharedAgentChatTranscriptHeld([], NEW_CHAT).readable).toBe(false)
  })
})
