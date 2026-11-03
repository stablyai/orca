import { BrowserWindow, ipcMain } from 'electron'
import { browserCookieImportFailure } from '../../shared/browser-cookie-import-failure-copy'
import type { BrowserCookieImportResult } from '../../shared/browser-workspace-types'
import {
  importCookieFileIntoClientRoutePartition,
  importCookiesIntoClientRoutePartition
} from '../browser/browser-client-route-cookie-import'
import { clientRouteCookieImportSources } from '../browser/client-route-cookie-import-source-store'
import { pickCookieFile } from '../browser/cookies/browser-cookie-import'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

export function registerClientHostCookieImportHandlers(): void {
  for (const channel of [
    'browser:session:importFromBrowserForClientHost',
    'browser:session:importCookiesForClientHost',
    'browser:session:clientRouteImportSources'
  ]) {
    ipcMain.removeHandler(channel)
  }

  // Client-hosted pages import this desktop's logins; the remote runtime is usually headless.
  ipcMain.handle(
    'browser:session:importFromBrowserForClientHost',
    async (
      event,
      args: {
        environmentId: string
        profileId: string
        browserFamily: string
        browserProfile?: string
      }
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      return importCookiesIntoClientRoutePartition({
        environmentId: args.environmentId,
        browserProfileId: args.profileId,
        browserFamily: args.browserFamily,
        browserProfile: args.browserProfile
      })
    }
  )

  // The file comes from this desktop's picker, so no remote path is ever read here.
  ipcMain.handle(
    'browser:session:importCookiesForClientHost',
    async (
      event,
      args: { environmentId: string; profileId: string }
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      return importCookieFileIntoClientRoutePartition(
        { environmentId: args.environmentId, browserProfileId: args.profileId },
        () => pickCookieFile(parent)
      )
    }
  )

  // Overlay desktop imports unavailable to the server's profile records.
  ipcMain.handle(
    'browser:session:clientRouteImportSources',
    (event, args: { environmentId: string }) => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.environmentId !== 'string') {
        return {}
      }
      return clientRouteCookieImportSources(args.environmentId)
    }
  )
}
