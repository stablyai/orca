import type { MobileNativeChatAskDraft } from '../../session/native-chat/input/prompts/use-mobile-native-chat-ask-answers'

// Each item ask's unsent answer card, for this app session: leaving the item and opening it again
// shows the picks and typed words as they were. A send clears it; the pending reply holds them then.
const drafts = new Map<string, Record<string, MobileNativeChatAskDraft>>()

/** One ask on one item; `itemKey` names the item on its host. */
export function botItemAskCardDraftKey(itemKey: string, askId: string): string {
  return `${itemKey}\0${askId}`
}

export function readBotItemAskCardDraft(
  key: string
): Readonly<Record<string, MobileNativeChatAskDraft>> | undefined {
  return drafts.get(key)
}

export function saveBotItemAskCardDraft(
  key: string,
  questionKey: string,
  draft: MobileNativeChatAskDraft
): void {
  const questions = { ...drafts.get(key) }
  if (draft.picks.length === 0 && !draft.other) {
    delete questions[questionKey]
  } else {
    questions[questionKey] = draft
  }
  if (Object.keys(questions).length > 0) {
    drafts.set(key, questions)
  } else {
    drafts.delete(key)
  }
}

export function clearBotItemAskCardDraft(key: string): void {
  drafts.delete(key)
}
