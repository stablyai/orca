// Each item's unsent comment text on the phone, for this app session, and the open box showing it.
export const botItemCommentDrafts = new Map<string, string>()
// The open box of each item, so text set from outside it (a late photo's [Image #N]) shows in its field.
export const shownBotItemCommentDrafts = new Map<string, (next: string) => void>()

/** Keyed by host too: two hosts can hold the same item ids. */
export function botItemCommentDraftKey(hostId: string, uid: string): string {
  return `${hostId}\0${uid}`
}

/** Puts a dropped comment's words back in the box, unless the owner has typed since. */
export function returnBotItemCommentDraft(key: string, text: string): void {
  if (text.trim() && !botItemCommentDrafts.get(key)?.trim()) {
    const shown = shownBotItemCommentDrafts.get(key)
    if (shown) {
      shown(text)
    } else {
      botItemCommentDrafts.set(key, text)
    }
  }
}
