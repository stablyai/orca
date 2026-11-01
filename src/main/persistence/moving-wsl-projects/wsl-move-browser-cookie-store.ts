/** Registers the `browser-cookies` rewrite store against the app's real browser sessions. */
import { BrowserWindow } from 'electron'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { WSL_MOVE_BROWSER_COOKIES_STORE_ID } from '../../../shared/wsl-move/wsl-move-browser-cookie-copy'
import {
  copyBrowserPartitionCookies,
  flushBrowserPartitionCookies
} from '../../browser/browser-partition-cookie-copy'
import { activeBrowserRoutePartitionOrcaProfileId } from '../../browser/browser-route-partition-binding-runtime'
import { browserSessionRegistry } from '../../browser/browser-session-registry'
import { browserSessionsInitialized } from '../../browser/browser-session-startup'
import {
  bindWslHostBrowserRoutePartition,
  wslHostBrowserRouteStorage
} from '../../browser/wsl-host-browser-route-partition'
import {
  runWslMoveBrowserCookieCopy,
  type WslMoveBrowserCookieCopyDependencies
} from './wsl-move-browser-cookie-copy'
import { registerWslMoveDesktopRewriteStore } from './wsl-move-desktop-rewrite-stores'

export function productionWslMoveBrowserCookieCopyDependencies(
  userDataPath: string
): WslMoveBrowserCookieCopyDependencies {
  return {
    userDataPath,
    // Why a window: win32 quits on window-all-closed, which the copy's hidden windows would trigger.
    sessionsReady: () =>
      browserSessionsInitialized() &&
      BrowserWindow.getAllWindows().some((window) => !window.isDestroyed()),
    orcaProfileId: activeBrowserRoutePartitionOrcaProfileId,
    listEnvironments: () => listEnvironments(userDataPath),
    listBrowserProfiles: () => browserSessionRegistry.listProfiles(),
    resolveHostStorage: wslHostBrowserRouteStorage,
    bindHostPartition: bindWslHostBrowserRoutePartition,
    copyCookies: copyBrowserPartitionCookies,
    flushCookies: flushBrowserPartitionCookies
  }
}

/**
 * Register last among main stores: until browser sessions and a window exist it fails, which pauses
 * the stores after it in that pass too. The pass started once the first window shows finishes it.
 */
export function registerWslMoveBrowserCookieStore(
  dependencies: WslMoveBrowserCookieCopyDependencies
): void {
  let unflushed: string[] = []
  registerWslMoveDesktopRewriteStore({
    id: WSL_MOVE_BROWSER_COOKIES_STORE_ID,
    side: 'main',
    run: async (context) => {
      unflushed = await runWslMoveBrowserCookieCopy(dependencies, context)
    },
    flush: async () => {
      await Promise.all(unflushed.map((partition) => dependencies.flushCookies(partition)))
      unflushed = []
    }
  })
}
