import { createContext, useContext } from 'react'
import type { BotPanelOpen } from './MobileBotPanel'

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

/** Opens the chat's bot's panel on a page, as Settings › Memory or an automation's editor (MobileSessionSurface
 *  provides it); null where nothing can (an older host), so a card keeps its plain line. */
export type BotPanelOpener = {
  botId: string
  open: (open: BotPanelOpen) => void
  /** The bot's automations as last read, so a run of a deleted one offers no Open. */
  automationIds: ReadonlySet<string>
}

export const BotPanelOpenContext = createContext<BotPanelOpener | null>(null)

/** The opener for this bot's cards; null for another bot's, whose panel this chat doesn't hold. */
export function useBotPanelOpener(botId: string | undefined): BotPanelOpener | null {
  const opener = useContext(BotPanelOpenContext)
  return opener && opener.botId === botId ? opener : null
}
