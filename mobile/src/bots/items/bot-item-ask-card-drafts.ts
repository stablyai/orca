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

/** Drops the item's card once the host's read retires its ask: the item closed, or the read names
 *  another ask (`askId`). The loaded events don't decide: a page still reading older history shows
 *  no ask yet. Naming none keeps it too: the one card per item stays the only copy. */
export function retireBotItemAskCardDraft(
  itemKey: string,
  host: { askId: string | null; closed: boolean }
): void {
  const draft = drafts.get(itemKey)
  if (draft && (host.closed || (host.askId !== null && host.askId !== draft.askId))) {
    drafts.delete(itemKey)
  }
}
