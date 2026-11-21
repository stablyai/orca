import { getPairedRuntimeBrowserClientRouteIdentity } from '../../browser/client-hosts/lifecycle/paired-runtime-browser-client-host-runtime'
import { BrowserWindow, ipcMain } from 'electron'
import { browserCookieImportFailure } from '../../../shared/browser/cookies/browser-cookie-import-failure-copy'
import type {
  BrowserCookieImportResult,
  BrowserCookieImportSelection
} from '../../../shared/browser/workspaces/browser-workspace-types'
import {
  importCookieFileIntoClientRoutePartition,
  importCookiesIntoClientRoutePartition
} from '../../browser/cookies/client-route/browser-client-route-cookie-import'
import { clientRouteCookieImportSources } from '../../browser/cookies/client-route/client-route-cookie-import-source-store'
import { pickCookieFile } from '../../browser/cookies/imports/cookie-file-picker'
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
      args: { environmentId: string; profileId: string } & BrowserCookieImportSelection
    ): Promise<BrowserCookieImportResult | null> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        return browserCookieImportFailure('notAuthorized')
      }
      return importCookiesIntoClientRoutePartition({ ...args, browserProfileId: args.profileId })
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
      const route = getPairedRuntimeBrowserClientRouteIdentity(args.environmentId)
      return route
        ? clientRouteCookieImportSources(args.environmentId, route.authorityConnectionIdentity)
        : null
    }
  )
}
