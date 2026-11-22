import type { BotChatTreeIndex } from './bot-chat-tree-index'
import type { BotItemsHost } from './bot-items-runtime'
import type { BotChatAutoClose } from './bot-chat-auto-close'

export type { BotChatAutoClose }

/** The bot and chat a session is, for the turn hooks; null for a session that is no bot's. */
export function botChatOfSession(
  runtime: {
    botChatTreeIndex: Pick<BotChatTreeIndex, 'botOfSession'> | null
    botItems: Pick<BotItemsHost, 'chatRootOf'>
  },
  sessionId: string
): { botId: string; chatId: string } | null {
  const botId = runtime.botChatTreeIndex?.botOfSession(sessionId) ?? null
  return botId ? { botId, chatId: runtime.botItems.chatRootOf(sessionId) } : null
}

/** A bot chat's turn started (a message reached it, from any device) or ended: its countdown hears of it. */
export function botChatAutoCloseTurn(
  runtime: Parameters<typeof botChatOfSession>[0] & {
    botChatAutoClose: Pick<BotChatAutoClose, 'turnStarted' | 'turnEnded'> | null
  },
  sessionId: string,
  phase: 'started' | 'ended'
): void {
  const chat = botChatOfSession(runtime, sessionId)
  if (!chat || !runtime.botChatAutoClose) {
    return
  }
  if (phase === 'started') {
    void runtime.botChatAutoClose.turnStarted(chat.botId, chat.chatId)
  } else {
    runtime.botChatAutoClose.turnEnded(chat.botId, chat.chatId)
  }
}
