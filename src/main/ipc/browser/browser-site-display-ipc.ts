import { ipcMain, webContents, type IpcMainInvokeEvent } from 'electron'
import { browserSiteDisplayController } from '../../browser/site-settings/browser-site-display-controller'
import { measureBrowserPageFitLevel } from '../../browser/site-settings/browser-page-fit-width-script'
import { isBrowserPageZoomDirection } from '../../../shared/browser-page-zoom'
import {
  isBrowserSiteColorScheme,
  type BrowserPageSiteDisplay
} from '../../../shared/browser-site-display'

/** Site zoom, appearance, and fit-width for a browser page; pageGuestId gates trust. */
export function registerBrowserSiteDisplayHandlers(
  pageGuestId: (event: IpcMainInvokeEvent, browserPageId: unknown) => number | null
): void {
  ipcMain.removeHandler('browser:getPageSiteDisplay')
  ipcMain.removeHandler('browser:zoomPage')
  ipcMain.removeHandler('browser:setPageSiteColorScheme')
  ipcMain.removeHandler('browser:setPageSiteFitWidth')

  ipcMain.handle(
    'browser:getPageSiteDisplay',
    (event, args: { browserPageId: string }): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      return guestId === null ? null : browserSiteDisplayController.getPageDisplay(guestId)
    }
  )

  ipcMain.handle(
    'browser:zoomPage',
    async (
      event,
      args: { browserPageId: string; direction: unknown }
    ): Promise<BrowserPageSiteDisplay | null> => {
      const guestId = pageGuestId(event, args?.browserPageId)
      const { direction } = args
      if (guestId === null || !isBrowserPageZoomDirection(direction)) {
        return null
      }
      const guest = direction === 'reset' ? undefined : webContents.fromId(guestId)
      const fitLevel = guest ? await measureBrowserPageFitLevel(guest) : null
      return browserSiteDisplayController.zoomPage(guestId, direction, fitLevel)
    }
  )

  ipcMain.handle(
    'browser:setPageSiteColorScheme',
    (
      event,
      args: { browserPageId: string; colorScheme: unknown }
    ): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      const { colorScheme } = args
      if (guestId === null || (colorScheme !== null && !isBrowserSiteColorScheme(colorScheme))) {
        return null
      }
      return browserSiteDisplayController.setColorScheme(guestId, colorScheme)
    }
  )

  ipcMain.handle(
    'browser:setPageSiteFitWidth',
    (event, args: { browserPageId: string; fitWidth: unknown }): BrowserPageSiteDisplay | null => {
      const guestId = pageGuestId(event, args?.browserPageId)
      if (guestId === null || typeof args.fitWidth !== 'boolean') {
        return null
      }
      return browserSiteDisplayController.setFitWidth(guestId, args.fitWidth)
    }
  )
}
