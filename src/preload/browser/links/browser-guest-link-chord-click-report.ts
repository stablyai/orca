import type { BrowserGuestLinkChordClick } from '../../../shared/browser/guest-lifecycle/browser-guest-link-chord-click'

/** Electron's guest mouse input carries no modifiers, so the isolated world reports chord clicks; page script cannot reach it or forge isTrusted. */
export function installBrowserGuestLinkChordClickReport(
  send: (click: BrowserGuestLinkChordClick) => void
): void {
  const report = (event: MouseEvent): void => {
    if (event.isTrusted && event.shiftKey && (event.metaKey || event.ctrlKey)) {
      send({ metaKey: event.metaKey, ctrlKey: event.ctrlKey })
    }
  }
  // Capture on window runs before page listeners can stop the click.
  window.addEventListener('click', report, true)
  window.addEventListener('auxclick', report, true)
}
