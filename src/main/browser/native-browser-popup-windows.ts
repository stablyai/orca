import type { BrowserWindow } from 'electron'

// Why: native popups are the only BrowserWindows that host a web page instead of Orca's renderer,
// so window-wide routing (menu IPC, renderer targets) must be able to tell them apart.
const nativeBrowserPopupWindows = new WeakSet<BrowserWindow>()

export function markNativeBrowserPopupWindow(window: BrowserWindow): void {
  nativeBrowserPopupWindows.add(window)
}

export function isNativeBrowserPopupWindow(window: BrowserWindow | null | undefined): boolean {
  return window != null && nativeBrowserPopupWindows.has(window)
}
