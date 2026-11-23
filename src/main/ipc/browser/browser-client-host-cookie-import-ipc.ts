import { BrowserWindow, ipcMain } from 'electron'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type {
  BrowserCookieImportFromBrowserRequest,
  BrowserCookieImportResult
} from '../../../shared/browser/workspaces/browser-workspace-types'
import { refusesSavedSourceRefresh } from '../../browser/cookies/sources/browser-cookie-source-profiles'
import {
  importCookieFileIntoClientRoutePartition,
  importCookiesIntoClientRoutePartition
} from '../../browser/cookies/client-route/browser-client-route-cookie-import'
import { clearClientRouteDefaultCookies } from '../../browser/cookies/client-route/browser-client-route-cookie-clear'
import {
  clientRouteCookieImportSources,
  readClientRouteCookieImportSource
} from '../../browser/cookies/client-route/client-route-cookie-import-source-store'
import { pickCookieFile } from '../../browser/cookies/imports/cookie-file-picker'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'
import { getPairedRuntimeBrowserClientRouteIdentity } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'

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
      args: ClientHostCookieImportTargetArgs & BrowserCookieImportFromBrowserRequest
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      // A refresh replays this desktop's record, never a folder the server listed.
      if (
        args.refreshSavedSource &&
        getPairedRuntimeBrowserClientRouteIdentity(args.environmentId) &&
        refusesSavedSourceRefresh(
          await readClientRouteCookieImportSource(args.environmentId, args.profileId),
          args
        )
      ) {
        return browserCookieImportFailure('savedSourceUnavailable')
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

  // Null unless this desktop hosts the pages; hosted pages use only this desktop's jar.
  ipcMain.handle(
    'browser:session:clientRouteImportSources',
    (event, args: { environmentId: string }) => {
      if (
        !isTrustedBrowserRenderer(event.sender) ||
        typeof args?.environmentId !== 'string' ||
        !getPairedRuntimeBrowserClientRouteIdentity(args.environmentId)
      ) {
        return null
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
