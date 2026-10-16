import type { BrowserWindow } from 'electron'

/** Tells the window's renderer when it gains or loses OS focus. */
export function installWindowFocusRelay(window: BrowserWindow): void {
  // Why: DOM blur also fires when focus moves into a webview, so the renderer can't see app switches.
  const relay = (focused: boolean) => (): void => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('window:focus-changed', focused)
    }
  }
  window.on('focus', relay(true))
  window.on('blur', relay(false))
}
