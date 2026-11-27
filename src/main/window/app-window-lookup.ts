import { BrowserWindow } from 'electron'

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
