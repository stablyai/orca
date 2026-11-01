import { ipcMain, session } from 'electron'
import { browserManager } from '../browser/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerBrowserBrowsingDataHandlers(): void {
  ipcMain.removeHandler('browser:clearBrowsingData')
  ipcMain.handle(
    'browser:clearBrowsingData',
    async (
      event,
      args: { browserPageId: string; partition: string; cookies: boolean; cache: boolean }
    ): Promise<string> => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.partition !== 'string' ||
        !args.partition ||
        typeof args.cookies !== 'boolean' ||
        typeof args.cache !== 'boolean'
      ) {
        throw new Error('Invalid browsing data request')
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      if (
        !guest ||
        guest.isDestroyed() ||
        browserManager.getGuestWebContentsId(args.browserPageId) !== guest.id ||
        guest.session === session.defaultSession
      ) {
        throw new Error('The browser page is unavailable. Reopen it and try again.')
      }
      const { partition } = args
      if (!partition || guest.session !== session.fromPartition(partition)) {
        throw new Error('The browser partition is unavailable.')
      }
      if (args.cookies) {
        await guest.session.clearStorageData({
          storages: [
            'cookies',
            'localstorage',
            'indexdb',
            'serviceworkers',
            'cachestorage',
            'filesystem'
          ]
        })
      }
      if (args.cache) {
        await guest.session.clearCache()
      }
      return partition
    }
  )
}
