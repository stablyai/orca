import type { MobileNativeChatAskDraft } from '../../session/native-chat/input/prompts/use-mobile-native-chat-ask-answers'

// Each item's unsent answer card, for this app session: leaving the item and opening it again shows
// the picks and typed words as they were. One per item, for the ask it answers: a newer ask's card
// takes its place, and it goes once the host's read shows no ask open (answered or closed).
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

/** Drops the item's card unless it answers `openAskId`, the ask the host's read has open. */
export function retireBotItemAskCardDraft(itemKey: string, openAskId: string | null): void {
  if (drafts.get(itemKey)?.askId !== openAskId) {
    drafts.delete(itemKey)
  }
}
