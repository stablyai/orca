/** Reports Chromium's visibility for this document, which Electron's webview hides from document.visibilityState. */
export function installBrowserGuestPageVisibilityReport(
  send: (state: DocumentVisibilityState) => void
): void {
  let reported: DocumentVisibilityState | null = null
  const report = (): void => {
    // Electron overrides visibilityState and hidden but leaves the prefixed property alone.
    const state: unknown = Reflect.get(document, 'webkitVisibilityState')
    if ((state === 'visible' || state === 'hidden') && state !== reported) {
      reported = state
      send(state)
    }
  }
  document.addEventListener('visibilitychange', report)
  report()
}
