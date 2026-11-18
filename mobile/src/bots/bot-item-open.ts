import { createContext } from 'react'

/** The page one bot item opens on. */
export const BOT_ITEM_ROUTE = 'bot-item'

export type BotItemRouteParams = { hostId: string; botId: string; itemUid: string }

/** Opens an item of the chat's bot on its page in the bot panel (MobileSessionSurface provides it); null
 *  where nothing can open one (an older host), so its chips stay plain text. */
export const BotItemOpenContext = createContext<((itemUid: string) => void) | null>(null)

/** Opens one of the chat's bot's chats by its chat id, Home Chat by its live tab (MobileSessionSurface
 *  provides it); null where nothing can open one, so a chat chip stays plain text. */
export const BotChatOpenContext = createContext<
  ((chat: { chatId: string; home?: true }) => void) | null
>(null)
