// Leaf so main-window readiness can reset guest losses without importing the discarded-tab model.
/**
 * Pages whose guest went away. A closed page stays in the saved session until the renderer's next
 * write, so it is listed again only once a write still saves it (an evicted guest's page).
 */
export const unloadedPageIds = new Set<string>()

export function noteBrowserPageGuestGone(browserPageId: string): void {
  unloadedPageIds.add(browserPageId)
}

/** A restored renderer remounts from the saved session, so no guest loss there is a close. */
export function forgetBrowserPageGuestsGone(): void {
  unloadedPageIds.clear()
}
