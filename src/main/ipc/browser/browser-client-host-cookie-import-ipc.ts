import { BrowserWindow, ipcMain } from 'electron'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type { BrowserCookieImportResult } from '../../../shared/browser/workspaces/browser-workspace-types'
import {
  importCookieFileIntoClientRoutePartition,
  importCookiesIntoClientRoutePartition
} from '../../browser/cookies/client-route/browser-client-route-cookie-import'
import { clearClientRouteDefaultCookies } from '../../browser/cookies/client-route/browser-client-route-cookie-clear'
import { clientRouteCookieImportSources } from '../../browser/cookies/client-route/client-route-cookie-import-source-store'
import { pickCookieFile } from '../../browser/cookies/imports/cookie-file-picker'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

type ClientHostCookieImportTargetArgs = {
  environmentId: string
  profileId: string
  /** The server's metadata for profileId; checked in main like page creation checks it. */
  profile?: unknown
  /** Set when a page imports into its own jar. */
  browserPageId?: unknown
}

function clientHostCookieImportTarget(args: ClientHostCookieImportTargetArgs) {
  return {
    environmentId: args.environmentId,
    browserProfileId: args.profileId,
    ...(args.profile ? { profile: args.profile } : {}),
    ...(typeof args.browserPageId === 'string' && args.browserPageId.length > 0
      ? { browserPageId: args.browserPageId }
      : {})
  }
}

export function registerClientHostCookieImportHandlers(): void {
  for (const channel of [
    'browser:session:importFromBrowserForClientHost',
    'browser:session:importCookiesForClientHost',
    'browser:session:clientRouteImportSources',
    'browser:session:clearDefaultCookiesForClientHost'
  ]) {
    ipcMain.removeHandler(channel)
  }

  // Client-hosted pages import this desktop's logins; the remote runtime is usually headless.
  ipcMain.handle(
    'browser:session:importFromBrowserForClientHost',
    async (
      event,
      args: ClientHostCookieImportTargetArgs & {
        browserFamily: string
        browserProfile?: string
      }
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      return importCookiesIntoClientRoutePartition({
        ...clientHostCookieImportTarget(args),
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
      args: ClientHostCookieImportTargetArgs
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      return importCookieFileIntoClientRoutePartition(clientHostCookieImportTarget(args), () =>
        pickCookieFile(parent)
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

  // Clears the jar Settings import fills for this server's This-device pages.
  ipcMain.handle(
    'browser:session:clearDefaultCookiesForClientHost',
    async (event, args: { environmentId: string }): Promise<boolean | null> => {
      if (!isTrustedBrowserRenderer(event.sender) || typeof args?.environmentId !== 'string') {
        return false
      }
      return clearClientRouteDefaultCookies(args.environmentId)
    }
  )
}
