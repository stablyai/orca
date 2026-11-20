/** Reports Chromium's visibility for this frame's document, which Electron's webview hides from document.visibilityState. */
export function installBrowserGuestPageVisibilityReport(
  send: (state: DocumentVisibilityState) => void
): void {
  let reported: unknown = null
  const report = (force: boolean): void => {
    // Electron overrides visibilityState and hidden but leaves the prefixed property alone.
    const state = 'webkitVisibilityState' in document ? document.webkitVisibilityState : null
    if ((state === 'visible' || state === 'hidden') && (force || state !== reported)) {
      reported = state
      send(state)
    }
  }
  document.addEventListener('visibilitychange', () => report(false))
  // Electron drops a reply that reaches the document before its element exists, or before main sees the commit.
  document.addEventListener('DOMContentLoaded', () => report(true), { once: true })
  report(false)
}
