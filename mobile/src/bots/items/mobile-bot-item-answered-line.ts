// A question's recorded answer, as the phone's Activity shows it under the question.
import {
  botItemAnsweredQuestion,
  botItemQuestionFirstLine,
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

/** What a comment card quotes above its words: a reply's question, or, for a recorded answer whose
 *  question is off the loaded page, the prose question it kept (an ask's answer spells its decisions). */
export function mobileBotItemQuote(entry: BotItemActivityEntry): { text: string } | undefined {
  if (entry.kind === 'comment') {
    return entry.replyTo
  }
  const asked = entry.kind === 'answer' ? entry.event.data.asked : undefined
  const text = typeof asked === 'string' ? botItemQuestionFirstLine(asked) : ''
  return text ? { text } : undefined
}
