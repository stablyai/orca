import {
  botItemHostWaitingAsk,
  botItemQuestionPairing
} from '../../../../src/shared/bots/bot-item-question-answers'
import {
  parseBotItemEventId,
  type BotItem,
  type BotItemEvent
} from '../../../../src/shared/bots/bot-items'
import type { MobileNativeChatAskDraft } from '../../session/native-chat/input/prompts/use-mobile-native-chat-ask-answers'

// Each item's unsent answer card, for this app session: leaving the item and opening it again shows
// the picks and typed words as they were. One per item, for the ask it answers: it goes when the
// host's read names a newer ask or the item closes, and a newer ask's card takes its place.
// Only an open item page reads the host, so an item closed or answered elsewhere after you left it
// keeps its card until you open it again: the last few edited stay, the oldest go first.
export const KEPT_BOT_ITEM_ASK_CARDS = 20
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
    // Set again, so the card being edited is the newest and never the one that goes.
    drafts.delete(itemKey)
    drafts.set(itemKey, { askId, questions: kept })
    if (drafts.size > KEPT_BOT_ITEM_ASK_CARDS) {
      drafts.delete(drafts.keys().next().value!)
    }
  } else {
    drafts.delete(itemKey)
  }
}

/** Drops the item's card once the host's read shows its ask over: the item closed, the read names
 *  a newer ask, or it names none and the loaded events hold the ask with no line still waiting.
 *  An ask whose event isn't loaded yet (older history still reading) keeps its card, and so does
 *  one newer than the ask an older item read still names (a read split across two moments). */
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
      ? (parseBotItemEventId(named) ?? 0) > (parseBotItemEventId(draft.askId) ?? 0)
      : botItemQuestionPairing(item, events).questions.get(draft.askId)?.waiting === false)
  drafts.delete(itemKey)
  if (!over) {
    // Still waiting, on a page open now: it counts as just used, so it isn't the one that goes.
    drafts.set(itemKey, draft)
  }
}
