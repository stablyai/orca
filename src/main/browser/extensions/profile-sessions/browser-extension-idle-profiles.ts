import { webContents } from 'electron'
import { isHiddenHelperContents } from '../../hidden-helper-window'
import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import {
  savedBrowserTabPartitions,
  onSavedBrowserTabsWritten
} from '../tabs-and-windows/browser-extension-discarded-tabs'
import {
  getBrowserExtensionProfile,
  getBrowserExtensionSessionForProfile,
  unloadBrowserExtensionsFromIdleProfile,
  whenBrowserExtensionProfileUnloaded
} from './browser-extension-session-loader'

// Why a grace period: closing a tab and opening another shouldn't restart every extension.
const IDLE_PROFILE_UNLOAD_DELAY_MS = 60_000

const idleChecks = new Map<string, NodeJS.Timeout>()
/** Observed pages alive per extension session, so a close never scans every WebContents. */
const livePages = new WeakMap<Electron.Session, number>()
/** Profiles with no live page that only saved tabs kept running, by partition: a session write may drop the last one. */
const keptBySavedTabs = new Map<string, { sess: Electron.Session; partition: string }>()
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
  onSavedBrowserTabsWritten(() => {
    if (keptBySavedTabs.size === 0) {
      return
    }
    // One pass for every waiting profile; a profile is checked again only once its tabs are gone.
    const saved = savedBrowserTabPartitions()
    for (const [profileId, kept] of keptBySavedTabs) {
      if (!saved.has(kept.partition)) {
        keptBySavedTabs.delete(profileId)
        scheduleIdleBrowserExtensionProfileCheck(profileId, kept.sess)
      }
    }
  })
}

/** Counts an observed page toward its profile; when the profile's last one closes, the idle check starts. */
export function trackBrowserExtensionPage(profileId: string, contents: Electron.WebContents): void {
  const sess = contents.session
  livePages.set(sess, (livePages.get(sess) ?? 0) + 1)
  contents.once('destroyed', () => {
    const left = (livePages.get(sess) ?? 1) - 1
    livePages.set(sess, left)
    if (left === 0) {
      scheduleIdleBrowserExtensionProfileCheck(profileId, sess)
    }
  })
}

/**
 * Open tabs keep a profile's extensions running, as in Chromium, including tabs Memory Saver
 * freed and saved tabs not shown yet: only closing the profile's last tab stops them.
 */
function scheduleIdleBrowserExtensionProfileCheck(profileId: string, sess: Electron.Session): void {
  clearTimeout(idleChecks.get(profileId))
  const timer = setTimeout(() => {
    idleChecks.delete(profileId)
    keptBySavedTabs.delete(profileId)
    if ((livePages.get(sess) ?? 0) > 0) {
      return
    }
    const partition = getBrowserExtensionProfile(profileId)?.partition
    if (partition && savedBrowserTabPartitions().has(partition)) {
      keptBySavedTabs.set(profileId, { sess, partition })
      return
    }
    void unloadBrowserExtensionsFromIdleProfile(profileId, (reattachRequested) => {
      // Pages created while it unloaded saw no extension session, so they were never observed.
      const opened = webContents
        .getAllWebContents()
        .filter((contents) => !contents.isDestroyed() && contents.session === sess)
      if (!reattachRequested && !opened.some(isBrowserExtensionPageContents)) {
        return
      }
      browserSessionRegistry.attachExtensions(profileId)
      opened.forEach(observePage)
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
  if (sess && (livePages.get(sess) ?? 0) === 0) {
    scheduleIdleBrowserExtensionProfileCheck(profileId, sess)
  }
}
