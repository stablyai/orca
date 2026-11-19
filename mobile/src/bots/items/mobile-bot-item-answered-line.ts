// A question's recorded answer, as the phone's Activity shows it under the question.
import {
  botItemAnsweredQuestion,
  type BotItemActivityEntry
} from '../../../../src/shared/bots/bot-item-activity'
import type { Translate } from '../../i18n/mobile-i18n'

/** The line under a question its recorded answer closed; null otherwise. A reply that answered it has
 *  its own card, so it is not repeated here. */
export function mobileBotItemAnsweredLine(
  t: Translate,
  entry: BotItemActivityEntry
): string | null {
  const answer = entry.kind === 'comment' ? entry.answer : undefined
  if (!answer || botItemAnsweredQuestion(answer) === null) {
    return null
  }
  const text = typeof answer.data.text === 'string' ? answer.data.text : ''
  return `${t('bots.items.ask.youAnswered', 'You answered:')} ${text}`
}
