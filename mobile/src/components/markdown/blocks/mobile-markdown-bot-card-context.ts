import { createContext, type ReactNode } from 'react'
import type { NativeChatDirectiveBotCard } from '../../../../../src/shared/native-chat/bot-cards/native-chat-bot-card-kind'

/** Draws a bot card a reply line names (the chat provides it); null elsewhere, where the line says
 *  in words what the card would show. */
export const MobileMarkdownBotCardContext = createContext<
  ((card: NativeChatDirectiveBotCard) => ReactNode) | null
>(null)
