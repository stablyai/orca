import { webContents } from 'electron'
import {
  hasOpenBrowserPages,
  onBrowserPartitionPagesClosed
} from '../../guest-lifecycle/browser-page-partition-presence'
import { isHiddenHelperContents } from '../../hidden-helper-window'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionProfileForPartition,
  getBrowserExtensionSessionForProfile,
  unloadBrowserExtensionsFromIdleProfile,
  whenBrowserExtensionProfileUnloaded
} from './browser-extension-session-loader'

// Why a grace period: closing a tab and opening another shouldn't restart every extension.
const IDLE_PROFILE_UNLOAD_DELAY_MS = 60_000

const idleChecks = new Map<string, NodeJS.Timeout>()
/** Live pages per session; the browser page registry adds tabs whose page Memory Saver freed. */
const livePages = new WeakMap<Electron.Session, number>()
let observePage: (contents: Electron.WebContents) => void = () => {}

/** Tabs (webview guests and serve's offscreen pages) and extension windows. */
export function isBrowserExtensionPageContents(contents: Electron.WebContents): boolean {
  const type = contents.getType()
  return (
    (type === 'webview' || type === 'window' || type === 'offscreen') &&
    !isHiddenHelperContents(contents)
  )
}

/**
 * Installs the idle checks once. Desktop tabs come from the browser page registry, which keeps a
 * tab Memory Saver freed until it closes, so only closing a profile's last tab stops its extensions,
 * as in Chromium. `observe` gives pages opened during an unload their extension observers.
 */
export function installIdleBrowserExtensionProfiles(
  observe: (contents: Electron.WebContents) => void
): void {
  observePage = observe
  onBrowserPartitionPagesClosed((partition) => {
    const profileId = getBrowserExtensionProfileForPartition(partition)?.id
    const sess = profileId ? getBrowserExtensionSessionForProfile(profileId) : null
    if (profileId && sess) {
      scheduleIdleCheck(profileId, sess)
    }
  })
}

/** Counts an observed live page toward its profile. */
export function trackBrowserExtensionPage(profileId: string, contents: Electron.WebContents): void {
  const sess = contents.session
  livePages.set(sess, (livePages.get(sess) ?? 0) + 1)
  contents.once('destroyed', () => {
    const left = (livePages.get(sess) ?? 1) - 1
    livePages.set(sess, left)
    if (left === 0) {
      scheduleIdleCheck(profileId, sess)
    }
  })
}

function hasPages(profileId: string, sess: Electron.Session): boolean {
  const partition = getBrowserExtensionProfile(profileId)?.partition ?? null
  return (livePages.get(sess) ?? 0) > 0 || (partition !== null && hasOpenBrowserPages(partition))
}

function scheduleIdleCheck(profileId: string, sess: Electron.Session): void {
  clearTimeout(idleChecks.get(profileId))
  const partition = getBrowserExtensionProfile(profileId)?.partition ?? null
  const timer = setTimeout(() => {
    idleChecks.delete(profileId)
    if (hasPages(profileId, sess)) {
      return
    }
    void unloadBrowserExtensionsFromIdleProfile(profileId, (reattachRequested) => {
      const reopened =
        (livePages.get(sess) ?? 0) > 0 || (partition !== null && hasOpenBrowserPages(partition))
      if (!reattachRequested && !reopened) {
        return
      }
      browserSessionRegistry.attachExtensions(profileId)
      // Pages created while it unloaded saw no extension session, so they were never observed.
      for (const contents of webContents.getAllWebContents()) {
        if (!contents.isDestroyed() && contents.session === sess) {
          observePage(contents)
        }
      }
      // A page that asked and already closed scheduled no check while the profile was detached.
      if (!reopened) {
        scheduleIdleCheck(profileId, sess)
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
  if (sess && !hasPages(profileId, sess)) {
    scheduleIdleCheck(profileId, sess)
  }
}
