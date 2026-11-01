import type { BrowserWindow } from 'electron'

// Window-wide menu and renderer routing must distinguish web popups from Orca renderers.
const nativeBrowserPopupWindows = new WeakSet<BrowserWindow>()

export function markNativeBrowserPopupWindow(window: BrowserWindow): void {
  nativeBrowserPopupWindows.add(window)
}

export function isNativeBrowserPopupWindow(window: BrowserWindow | null | undefined): boolean {
  return window != null && nativeBrowserPopupWindows.has(window)
}
