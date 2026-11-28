import { BrowserWindow, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type { BrowserCookieImportResult } from '../../../shared/browser/workspaces/browser-workspace-types'
import {
  importCookieFileIntoClientRoutePartition,
  importCookiesIntoClientRoutePartition
} from '../../browser/cookies/client-route/browser-client-route-cookie-import'
import {
  clientRouteCookieImportSources,
  sshCookieImportRoute
} from '../../browser/cookies/client-route/client-route-cookie-import-source-store'
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

export function registerClientHostCookieImportHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    for (const channel of [
      'browser:session:importFromBrowserForClientHost',
      'browser:session:importCookiesForClientHost',
      'browser:session:clientRouteImportSources'
    ]) {
      ipcMain.removeHandler(channel)
    }
  }

  // Client-hosted pages import this desktop's logins; the remote runtime is usually headless.
  ipc.handle(
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
  ipc.handle(
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

  // Overlay desktop imports unavailable to the server's profile records, or to an SSH host's.
  ipc.handle(
    'browser:session:clientRouteImportSources',
    (event, args: { environmentId?: unknown; sshTargetId?: unknown }) => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return {}
      }
      if (typeof args?.environmentId === 'string') {
        return clientRouteCookieImportSources(args.environmentId)
      }
      return typeof args?.sshTargetId === 'string'
        ? clientRouteCookieImportSources(sshCookieImportRoute(args.sshTargetId))
        : {}
    }
  )
}
