import type { WebContents } from 'electron'

export type BrowserRouteGuestPopupWindow = {
  contentWebContents: WebContents
  close: () => void
  onClosed: (listener: () => void) => void
}

// Allow OAuth sizing without deceptive or inescapable native chrome.
export const ROUTE_POPUP_WINDOW_OPTIONS = {
  alwaysOnTop: false,
  closable: true,
  focusable: true,
  frame: true,
  fullscreen: false,
  kiosk: false,
  modal: false,
  movable: true,
  opacity: 1,
  show: true,
  simpleFullscreen: false,
  skipTaskbar: false,
  titleBarStyle: 'default',
  transparent: false,
  webPreferences: {
    allowRunningInsecureContent: false,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false
  }
} satisfies Electron.BrowserWindowConstructorOptions
