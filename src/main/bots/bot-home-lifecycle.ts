// A person's Home Chat over its life: opened as it is while it runs the agent's own CLI, else replaced by
// a new one that takes over its queued messages and its Home name.
import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import { botHome, botHomeOpenable, type BotHomeOf } from '../../shared/bots/bot-home-of'
import { carryQueuedMessages } from './bot-chat-queued-carry'
import type { BotChatDependencies, BotChatHost } from './bot-chat-session'
import { nameNewHome } from './bot-home-chat-name'

export function botHomeLifecycle(
  deps: Pick<BotChatDependencies, 'bots' | 'createChat' | 'closeChat' | 'dropUnreadMail'>
) {
  /** Retired first, so a failure leaves the agent pointing at its old Home for the retry. */
  const replace = async (host: BotChatHost, bot: Bot, of: BotHomeOf): Promise<string> => {
    // A removed or declined teammate never gets a chat made for them.
    if (!botHomeOpenable(bot, of)) {
      throw new Error('bot_not_shared')
    }
    const replaced = botHome(bot, of)
    if (replaced && host.deps.store.getConversation(replaced)) {
      const closed = await deps.closeChat(replaced)
      if (!closed.stopped) {
        throw new Error(`bot_chat_close_failed: ${closed.reason ?? 'unknown'}`)
      }
    }
    const sessionId = randomUUID()
    await deps.createChat(bot, sessionId, of)
    // Saved before anything else can fail, so the agent never loses a Home it made.
    const saved = await deps.bots.setHome(bot.id, of, sessionId)
    await carryQueuedMessages(host, replaced, sessionId)
    await deps.dropUnreadMail(bot, replaced)
    await nameNewHome(host, saved, of, sessionId, replaced)
    return sessionId
  }

  /** The current Home, or a new one when it is gone or runs another CLI than the agent's. */
  const open = (host: BotChatHost, bot: Bot, of: BotHomeOf): Promise<string> | string => {
    const home = botHome(bot, of)
    const record = home ? host.deps.store.getConversation(home) : null
    return record?.provider === bot.agent ? record.sessionId : replace(host, bot, of)
  }

  return { replace, open }
}
