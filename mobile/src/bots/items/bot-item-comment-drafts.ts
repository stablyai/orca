import {
  appendNativeChatQuote,
  formatNativeChatQuote
} from '../../../../src/shared/native-chat/input/quotes/native-chat-quote-selection'

// Each item's unsent comment text on the phone, for this app session, and the open box showing it.
export const botItemCommentDrafts = new Map<string, string>()
// The open box of each item, so text set from outside it (a late photo's [Image #N]) shows in its field.
export const shownBotItemCommentDrafts = new Map<string, (next: string) => void>()

/** Keyed by host too: two hosts can hold the same item ids. */
export function botItemCommentDraftKey(hostId: string, uid: string): string {
  return `${hostId}\0${uid}`
}

/** Sets an item's draft, in its box when one shows. */
function setBotItemCommentDraft(key: string, text: string): void {
  const shown = shownBotItemCommentDrafts.get(key)
  if (shown) {
    shown(text)
  } else {
    botItemCommentDrafts.set(key, text)
  }
}

/** Puts a dropped comment's words back in the box, after anything the owner has typed since. */
export function returnBotItemCommentDraft(key: string, text: string): void {
  const draft = botItemCommentDrafts.get(key) ?? ''
  if (text.trim() && !draft.includes(text)) {
    setBotItemCommentDraft(key, draft.trim() ? `${draft}\n${text}` : text)
  }
}

/** Puts a comment's words after the item's draft as a quote, in chat's quote format. */
export function quoteIntoBotItemCommentDraft(key: string, text: string): void {
  setBotItemCommentDraft(
    key,
    appendNativeChatQuote(botItemCommentDrafts.get(key) ?? '', formatNativeChatQuote(text))
  )
}
