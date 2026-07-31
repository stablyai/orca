import { BrowserWindow } from 'electron'

/**
 * Windows that paint status chrome rather than app UI — currently the notch indicator.
 *
 * Why: several call sites resolve "the app window" as the first non-destroyed window and then
 * ask whether it is visible or focused. A permanently-visible, non-focusable chrome window
 * would answer those questions for the app, silently suppressing tray attention and inverting
 * notification focus gating. Registering it here keeps it out of that lookup.
 */
const chromeWindowIds = new Set<number>()

export function registerChromeWindow(window: BrowserWindow): void {
  chromeWindowIds.add(window.id)
  window.once('closed', () => {
    chromeWindowIds.delete(window.id)
  })
}

export function isChromeWindow(window: BrowserWindow): boolean {
  return chromeWindowIds.has(window.id)
}

/** First live window presenting app UI, or null when only chrome windows remain. */
export function findAppWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getAllWindows().find(
      (window) => !window.isDestroyed() && !chromeWindowIds.has(window.id)
    ) ?? null
  )
}

/** Test seam; production registration is driven by window lifecycle. */
export function resetChromeWindowRegistryForTests(): void {
  chromeWindowIds.clear()
}
