import type { BotItemPendingComment } from '../../../../src/shared/bots/bot-item-pending-comments'
import { botItemRefusedReplyText } from '../../../../src/shared/bots/bot-item-refused-reply'
import { returnBotItemCommentDraft } from './bot-item-comment-drafts'
import { readPhoneBotItemHeldAnswers } from './use-phone-bot-item-question-steps'

/** A replaced question's reply, dropped: what its ask's held answers don't keep goes to the item's
 *  comment box (`draftKey`), a card's answers too, so none is lost. `key`: the item on its host. */
export function phoneBotItemReturnText(key: string, draftKey: string) {
  return (text: string, { intent }: BotItemPendingComment): void => {
    const held = intent ? readPhoneBotItemHeldAnswers(key, intent.askId) : ''
    returnBotItemCommentDraft(draftKey, botItemRefusedReplyText(intent, text, held))
  }
}
