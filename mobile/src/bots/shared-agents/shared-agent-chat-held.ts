// What a teammate's held messages to a shared agent show on the phone: the agent's chats with the new
// ones only its held messages name, each chat's latest held word, and a chat's held messages as sent
// rows until its host's own rows replace them.
import { agentJournalSubmissionKey } from '../../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import type { BotChatTreeChat } from '../../../../src/shared/bots/bot-chat-tree'
import {
  isSharedBotNewChatId,
  type SharedBotHeldView
} from '../../../../src/shared/bots/shared-bot-hosts'
import type { MobileNativeChatInputLockReason } from '../../session/native-chat/MobileNativeChatView'
import type { MobileNativeChatPendingItem } from '../../session/native-chat/transcript/projection/mobile-native-chat-render-data'

/** A held message's word under it: still waiting, or refused and able to be sent again. */
export type SharedAgentHeldWord = { state: 'waiting' | 'not_sent'; clientMessageId: string }

/** The agent's chats, and a new chat for each placeholder its held messages name, newest first. */
export function sharedAgentChats(
  chats: readonly BotChatTreeChat[],
  held: readonly SharedBotHeldView[]
): BotChatTreeChat[] {
  const listed = new Set(chats.map((chat) => chat.chatId))
  const started = new Map<string, BotChatTreeChat>()
  for (const message of held) {
    if (
      listed.has(message.sessionId) ||
      !isSharedBotNewChatId(message.sessionId) ||
      message.state === 'delivered'
    ) {
      continue
    }
    const shown = started.get(message.sessionId)
    started.set(message.sessionId, {
      chatId: message.sessionId,
      title: '',
      origin: 'side',
      live: 'idle',
      lastActiveAt: Math.max(shown?.lastActiveAt ?? 0, message.sentAt),
      unread: false,
      closed: false,
      running: [],
      runningTotal: 0,
      finished: [],
      finishedTotal: 0,
      failedTotal: 0
    })
  }
  return [...started.values(), ...chats].toSorted((a, b) => b.lastActiveAt - a.lastActiveAt)
}

/** A chat's latest held message that hasn't landed, and its text, for the chat's row. */
export function sharedAgentChatHeld(
  held: readonly SharedBotHeldView[],
  chatId: string
): (SharedAgentHeldWord & { text: string }) | null {
  const last = held.findLast(
    (message) => message.sessionId === chatId && message.state !== 'delivered'
  )
  return last && last.state !== 'delivered'
    ? { state: last.state, clientMessageId: last.clientMessageId, text: last.text }
    : null
}

/** One chat's held messages drawn as sent rows, each with its word; a delivered one draws nothing,
 *  its host's row standing for it. A new chat's placeholder has nothing on its host to read. */
export function sharedAgentChatTranscriptHeld(
  held: readonly SharedBotHeldView[],
  sessionId: string
): {
  pending: MobileNativeChatPendingItem[]
  words: ReadonlyMap<string, SharedAgentHeldWord>
  readable: boolean
} {
  const shown = held.filter(
    (message) => message.sessionId === sessionId && message.state !== 'delivered'
  )
  const words = new Map<string, SharedAgentHeldWord>()
  const pending = shown.map((message) => {
    const id = agentJournalSubmissionKey(message.clientMessageId)
    if (message.state !== 'delivered') {
      words.set(id, { state: message.state, clientMessageId: message.clientMessageId })
    }
    return { id, text: message.text, sentAt: message.sentAt }
  })
  return { pending, words, readable: !isSharedBotNewChatId(sessionId) }
}

/** A shared chat's composer while its host is away: open when the agent holds sends, else gone, never
 *  queued as a paired server's chat is (that queue is the paired computer's, not the host's). */
export function sharedAgentChatInputLock(
  live: boolean,
  holds: boolean
): MobileNativeChatInputLockReason | null {
  return live || holds ? null : 'unreachable'
}
