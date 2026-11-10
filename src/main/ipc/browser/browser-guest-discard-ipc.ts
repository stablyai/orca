import { ipcMain } from 'electron'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { readBrowserGuestDiscardProtection } from '../../browser/guest-lifecycle/manager/registration/browser-guest-discard-protection'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerBrowserGuestDiscardHandlers(): void {
  ipcMain.removeHandler('browser:getGuestDiscardProtection')
  ipcMain.handle(
    'browser:getGuestDiscardProtection',
    (event, args: { browserPageId: string; webContentsId: number }) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return null
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      return guest && guest.id === args.webContentsId
        ? readBrowserGuestDiscardProtection(guest)
        : null
    }
  )
}
