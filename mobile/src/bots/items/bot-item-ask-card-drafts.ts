import {
  botItemHostWaitingAsk,
  botItemQuestionPairing
} from '../../../../src/shared/bots/bot-item-question-answers'
import type { BotItem, BotItemEvent } from '../../../../src/shared/bots/bot-items'
import type { MobileNativeChatAskDraft } from '../../session/native-chat/input/prompts/use-mobile-native-chat-ask-answers'

// Each item's unsent answer card, for this app session: leaving the item and opening it again shows
// the picks and typed words as they were. One per item, for the ask it answers: it goes when the
// host's read names a newer ask or the item closes, and a newer ask's card takes its place.
const drafts = new Map<
  string,
  { askId: string; questions: Readonly<Record<string, MobileNativeChatAskDraft>> }
>()

/** The card's answers for `askId` on the item `itemKey` names on its host. */
export function readBotItemAskCardDraft(
  itemKey: string,
  askId: string
): Readonly<Record<string, MobileNativeChatAskDraft>> | undefined {
  const draft = drafts.get(itemKey)
  return draft?.askId === askId ? draft.questions : undefined
}

/** Keeps the whole card as it stands, so a line left untouched since a failed Send stays too. */
export function saveBotItemAskCardDraft(
  itemKey: string,
  askId: string,
  questions: Readonly<Record<string, MobileNativeChatAskDraft>>
): void {
  const kept = Object.fromEntries(
    Object.entries(questions).filter(([, { picks, other }]) => picks.length > 0 || other)
  )
  if (Object.keys(kept).length > 0) {
    drafts.set(itemKey, { askId, questions: kept })
  } else {
    drafts.delete(itemKey)
  }
}

/** Drops the item's card once the host's read shows its ask over: the item closed, the read names
 *  another ask, or it names none and the loaded events hold the ask with no line still waiting.
 *  An ask whose event isn't loaded yet (older history still reading) keeps its card. */
export function retireBotItemAskCardDraft(
  itemKey: string,
  item: BotItem,
  events: readonly BotItemEvent[]
): void {
  const draft = drafts.get(itemKey)
  if (!draft) {
    return
  }
  const named = botItemHostWaitingAsk(item)
  const over =
    item.status === 'done' ||
    item.status === 'canceled' ||
    (named !== null
      ? named !== draft.askId
      : botItemQuestionPairing(item, events).questions.get(draft.askId)?.waiting === false)
  if (over) {
    drafts.delete(itemKey)
  }
}
