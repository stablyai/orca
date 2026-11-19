import {
  botItemFilterChat,
  type BotItemChatChoice,
  type BotItemFilter
} from '../../../../src/shared/bots/bot-item-groups'
import type { Translate } from '../../i18n/mobile-i18n'

/** The Items filter's chip text: its chat's name, or Needs you only; null while nothing is filtered. */
export function phoneBotItemFilterLabel(
  filter: BotItemFilter,
  chats: readonly BotItemChatChoice[],
  t: Translate
): string | null {
  const chatId = botItemFilterChat(filter)
  if (chatId !== null) {
    const chat = chats.find((choice) => choice.chatId === chatId)
    return chat?.kind === 'home'
      ? t('bots.items.homeChat', 'Home Chat')
      : (chat?.title ?? t('bots.items.chatFallback', 'Chat'))
  }
  return filter.needsYou ? t('bots.items.filter.needsYou', 'Needs you only') : null
}
