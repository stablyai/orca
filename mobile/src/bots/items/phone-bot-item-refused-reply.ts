import type { BotItemPendingComment } from '../../../../src/shared/bots/bot-item-pending-comments'
import { botItemRefusedReplyText } from '../../../../src/shared/bots/bot-item-refused-reply'
import {
  putBackBotItemReplyTarget,
  sessionBotItemReplyTargets
} from '../../../../src/shared/bots/bot-item-reply-target'
import { botItemCommentDrafts, returnBotItemCommentDraft } from './bot-item-comment-drafts'
import { readPhoneBotItemHeldAnswers } from './use-phone-bot-item-question-steps'

/** A replaced question's reply, dropped: what its ask's held answers don't keep goes to the item's
 *  comment box (`draftKey`), a card's answers too, so none is lost. `key`: the item on its host. */
export function phoneBotItemReturnText(key: string, draftKey: string) {
  return (text: string, { intent }: BotItemPendingComment): void => {
    const held = intent ? readPhoneBotItemHeldAnswers(key, intent.askId) : ''
    const words = botItemRefusedReplyText(intent, text, held)
    // Into an empty box, the words answer no question; after a draft, they take the draft's.
    if (words.trim() && !botItemCommentDrafts.get(draftKey)?.trim()) {
      putBackBotItemReplyTarget(sessionBotItemReplyTargets, key)
    }
    returnBotItemCommentDraft(draftKey, words)
  }
}
