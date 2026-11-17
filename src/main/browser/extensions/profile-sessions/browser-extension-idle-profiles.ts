import { webContents } from 'electron'
import { isHiddenHelperContents } from '../../hidden-helper-window'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { listDiscardedBrowserTabs } from '../tabs-and-windows/browser-extension-discarded-tabs'
import {
  getBrowserExtensionSessionForProfile,
  unloadBrowserExtensionsFromIdleProfile,
  whenBrowserExtensionProfileUnloaded
} from './browser-extension-session-loader'

// Why a grace period: closing a tab and opening another shouldn't restart every extension.
const IDLE_PROFILE_UNLOAD_DELAY_MS = 60_000

const idleChecks = new Map<string, NodeJS.Timeout>()
let observePage: (contents: Electron.WebContents) => void = () => {}

/** Tabs (webview guests and serve's offscreen pages) and extension windows: what keeps a profile running. */
export function isBrowserExtensionPageContents(contents: Electron.WebContents): boolean {
  const type = contents.getType()
  return (
    (type === 'webview' || type === 'window' || type === 'offscreen') &&
    !isHiddenHelperContents(contents)
  )
}

/** How pages get their extension observers; a reattach must observe pages opened meanwhile. */
export function setIdleBrowserExtensionPageObserver(
  observe: (contents: Electron.WebContents) => void
): void {
  observePage = observe
}

/**
 * Open tabs keep a profile's extensions running, as in Chromium, including tabs Memory Saver
 * freed and saved tabs not shown yet: only closing the profile's last tab stops them.
 */
function hasTab(sess: Electron.Session): boolean {
  return (
    webContents
      .getAllWebContents()
      .some(
        (contents) =>
          !contents.isDestroyed() &&
          contents.session === sess &&
          isBrowserExtensionPageContents(contents)
      ) || listDiscardedBrowserTabs().some((tab) => tab.session === sess)
  )
}

/** A page in this profile closed, or Settings started it: once it has no tab for a while, its extensions stop. */
export function scheduleIdleBrowserExtensionProfileCheck(
  profileId: string,
  sess: Electron.Session
): void {
  clearTimeout(idleChecks.get(profileId))
  const timer = setTimeout(() => {
    idleChecks.delete(profileId)
    if (hasTab(sess)) {
      return
    }
    void unloadBrowserExtensionsFromIdleProfile(profileId, (reattachRequested) => {
      if (!reattachRequested && !hasTab(sess)) {
        return
      }
      browserSessionRegistry.attachExtensions(profileId)
      // Pages created while it unloaded saw no extension session, so they were never observed.
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.session === sess) {
          observePage(contents)
        }
      }
    })
  }, IDLE_PROFILE_UNLOAD_DELAY_MS)
  timer.unref?.()
  idleChecks.set(profileId, timer)
}

/** Settings acts on a profile that may have no tab: start its extensions, and stop them again once idle. */
export async function startBrowserExtensionsForSettings(profileId: string): Promise<void> {
  browserSessionRegistry.attachExtensions(profileId)
  await whenBrowserExtensionProfileUnloaded(profileId)
  const sess = getBrowserExtensionSessionForProfile(profileId)
  if (sess) {
    scheduleIdleBrowserExtensionProfileCheck(profileId, sess)
  }
}
