import { ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'

let trustedBrowserRendererWebContentsId: number | null = null

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  trustedBrowserRendererWebContentsId = webContentsId
}

function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  if (sender.isDestroyed() || sender.getType() !== 'window') {
    return false
  }
  if (trustedBrowserRendererWebContentsId != null) {
    return sender.id === trustedBrowserRendererWebContentsId
  }

  const senderUrl = sender.getURL()
  if (process.env.ELECTRON_RENDERER_URL) {
    try {
      return new URL(senderUrl).origin === new URL(process.env.ELECTRON_RENDERER_URL).origin
    } catch {
      return false
    }
  }

  return senderUrl.startsWith('file://')
}

export function registerBrowserHandlers(): void {
  ipcMain.removeHandler('browser:registerGuest')
  ipcMain.removeHandler('browser:unregisterGuest')
  ipcMain.removeHandler('browser:openDevTools')

  ipcMain.handle(
    'browser:registerGuest',
    (event, args: { browserTabId: string; webContentsId: number }) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return false
      }
      browserManager.registerGuest({
        ...args,
        rendererWebContentsId: event.sender.id
      })
      return true
    }
  )

  ipcMain.handle('browser:unregisterGuest', (event, args: { browserTabId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    browserManager.unregisterGuest(args.browserTabId)
    return true
  })

  ipcMain.handle('browser:openDevTools', (event, args: { browserTabId: string }) => {
    if (!isTrustedBrowserRenderer(event.sender)) {
      return false
    }
    return browserManager.openDevTools(args.browserTabId)
  })
}
