import { ipcMain, webContents } from 'electron'
import { normalizeBrowserGuestSrc } from '../../../shared/browser/extensions/browser-extension-url'
import {
  prepareBrowserPageAttach,
  reserveBrowserPageDiscard,
  acknowledgeBrowserPageRemoval
} from '../../browser/guest-lifecycle/browser-page-memory'
import { browserManager } from '../../browser/guest-lifecycle/manager/browser-manager'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerBrowserGuestDiscardHandlers(): void {
  ipcMain.removeHandler('browser:preparePageAttach')
  ipcMain.handle(
    'browser:preparePageAttach',
    (event, args: { browserPageId?: unknown; partition?: unknown; url?: unknown }) => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.partition !== 'string' ||
        typeof args.url !== 'string'
      ) {
        throw new Error('Invalid browser page attach')
      }
      const url = normalizeBrowserGuestSrc(args.url)
      if (!url) {
        throw new Error('Invalid browser page URL')
      }
      return prepareBrowserPageAttach(args.browserPageId, event.sender.id, args.partition, url)
    }
  )
  ipcMain.removeAllListeners('browser:reserveGuestDiscard')
  ipcMain.on(
    'browser:reserveGuestDiscard',
    (event, args: { browserPageId?: unknown; webContentsId?: unknown }) => {
      let committed = false
      try {
        if (
          !isTrustedBrowserRenderer(event.sender) ||
          typeof args?.browserPageId !== 'string' ||
          typeof args.webContentsId !== 'number'
        ) {
          return
        }
        const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
        if (!guest || guest.id !== args.webContentsId) {
          return
        }
        if (
          !browserManager.isGuestMemoryProtected(args.browserPageId) &&
          reserveBrowserPageDiscard(args.browserPageId, guest)
        ) {
          committed = true
          browserManager.unregisterGuest(args.browserPageId, 'guest-destroyed')
        } else if (
          browserManager.readGuestDiscardProtection(args.browserPageId, guest).protection !==
          'discardable'
        ) {
          browserManager.invalidateGuestMemoryProtection(guest)
        }
      } catch {
        console.warn('[BrowserManager] Guest discard admission failed')
      } finally {
        event.returnValue = committed
      }
    }
  )
  ipcMain.removeAllListeners('browser:acknowledgeGuestRemoval')
  ipcMain.removeHandler('browser:acknowledgeGuestRemoval')
  ipcMain.handle(
    'browser:acknowledgeGuestRemoval',
    (event, args: { browserPageId?: unknown; webContentsId?: unknown }) => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.browserPageId !== 'string' ||
        typeof args.webContentsId !== 'number'
      ) {
        return
      }
      const guest = webContents.fromId(args.webContentsId)
      return guest
        ? acknowledgeBrowserPageRemoval(args.browserPageId, guest, event.sender.id)
        : true
    }
  )
  ipcMain.removeHandler('browser:getGuestDiscardProtection')
  ipcMain.handle(
    'browser:getGuestDiscardProtection',
    (event, args: { browserPageId: string; webContentsId: number }) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.browserPageId !== 'string') {
        return null
      }
      const guest = browserManager.getAuthorizedGuest(args.browserPageId, event.sender.id)
      return guest && guest.id === args.webContentsId
        ? browserManager.readGuestDiscardProtection(args.browserPageId, guest)
        : null
    }
  )
}
