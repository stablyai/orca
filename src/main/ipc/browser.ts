import { ipcMain } from 'electron'
import { browserManager } from '../browser/browser-manager'

export function registerBrowserHandlers(): void {
  ipcMain.removeHandler('browser:registerGuest')
  ipcMain.removeHandler('browser:unregisterGuest')
  ipcMain.removeHandler('browser:openDevTools')

  ipcMain.handle(
    'browser:registerGuest',
    (_event, args: { browserTabId: string; webContentsId: number }) => {
      browserManager.registerGuest(args)
    }
  )

  ipcMain.handle('browser:unregisterGuest', (_event, args: { browserTabId: string }) => {
    browserManager.unregisterGuest(args.browserTabId)
  })

  ipcMain.handle('browser:openDevTools', (_event, args: { browserTabId: string }) =>
    browserManager.openDevTools(args.browserTabId)
  )
}
