import { BrowserWindow } from 'electron'
import { getDocPreviewSession } from '../browser/doc-preview-protocol'
import { isBackgroundLaunch, showWindowWithoutStealingFocus } from './foreground-activation-policy'

export function revealPreviewWindow(window: BrowserWindow): void {
  if (!isBackgroundLaunch() && window.isMinimized()) {
    window.restore()
  }
  showWindowWithoutStealingFocus(window)
}

export function createPreviewWindow(title: string, htmlDocument: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 360,
    minHeight: 240,
    title,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      javascript: htmlDocument,
      ...(htmlDocument
        ? { session: getDocPreviewSession() }
        : { partition: 'orca-markdown-preview' })
    }
  })
  window.once('ready-to-show', () => showWindowWithoutStealingFocus(window))
  return window
}
