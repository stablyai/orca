import { webContents } from 'electron'
import { isHiddenHelperContents } from '../../hidden-helper-window'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { unloadBrowserExtensionsFromIdleProfile } from './browser-extension-session-loader'

// Why a grace period: closing a tab and opening another shouldn't restart every extension.
const IDLE_PROFILE_UNLOAD_DELAY_MS = 60_000

const idleChecks = new Map<string, NodeJS.Timeout>()

/** Tabs (webview guests and serve's offscreen pages) and extension windows: what keeps a profile running. */
export function isBrowserExtensionPageContents(contents: Electron.WebContents): boolean {
  const type = contents.getType()
  return (
    (type === 'webview' || type === 'window' || type === 'offscreen') &&
    !isHiddenHelperContents(contents)
  )
}

function hasLivePage(sess: Electron.Session): boolean {
  return webContents
    .getAllWebContents()
    .some(
      (contents) =>
        !contents.isDestroyed() &&
        contents.session === sess &&
        isBrowserExtensionPageContents(contents)
    )
}

/** A page in this profile closed: once none is left for a while, its extensions stop. */
export function scheduleIdleBrowserExtensionProfileCheck(
  profileId: string,
  sess: Electron.Session,
  observe: (contents: Electron.WebContents) => void
): void {
  clearTimeout(idleChecks.get(profileId))
  const timer = setTimeout(() => {
    idleChecks.delete(profileId)
    if (hasLivePage(sess)) {
      return
    }
    void unloadBrowserExtensionsFromIdleProfile(profileId, (reattachRequested) => {
      if (!reattachRequested && !hasLivePage(sess)) {
        return
      }
      browserSessionRegistry.attachExtensions(profileId)
      // Pages created while it unloaded saw no extension session, so they were never observed.
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.session === sess) {
          observe(contents)
        }
      }
    })
  }, IDLE_PROFILE_UNLOAD_DELAY_MS)
  timer.unref?.()
  idleChecks.set(profileId, timer)
}
