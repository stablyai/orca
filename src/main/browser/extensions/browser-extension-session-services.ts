import { browserSessionRegistry } from '../browser-session-registry'
import { webContents } from 'electron'
import { parseChromeExtensionUrl } from '../../../shared/browser-extension-url'
import { browserManager } from '../browser-manager'
import { observeBrowserExtensionCookieChanges } from './api/cookies'
import { observeBrowserExtensionActionSession } from './browser-extension-action-registry'
import { revokeBrowserExtensionActiveTabInSession } from './browser-extension-active-tab'
import { getBrowserExtensionProfileIdForSession } from './browser-extension-api-host'
import { getActiveBrowserTabId } from './browser-extension-tab-model'
import {
  forgetBrowserExtensionContentScriptRestore,
  restoreBrowserExtensionContentScripts
} from './api/scripting'
import { setBrowserSessionRequestDecider } from '../browser-session-request-decisions'
import { browserExtensionDnrRequestDecider } from './browser-extension-dnr-requests'
import {
  attachBrowserExtensionDnr,
  whenBrowserExtensionDnrLoaded
} from './browser-extension-dnr-session'
import { setBrowserExtensionSessionHooks } from './browser-extension-session-loader'
import {
  installBrowserExtensionWebRequestForwarding,
  observeBrowserExtensionWebRequests,
  stopObservingBrowserExtensionWebRequests
} from './browser-extension-web-request'

// Why once: a session outlives the experimental setting being switched off and on again.
const servedSessions = new WeakSet<Electron.Session>()

// Why below startup's 3s wait: a worker that never answers must not use the whole budget alone.
const CONTENT_SCRIPT_RESTORE_TIMEOUT_MS = 2_500

/** A download from an unregistered extension page (popup, popout) belongs to the active tab. */
function resolveExtensionDownloadOwner(webContentsId: number): string | null {
  const contents = webContents.fromId(webContentsId)
  if (
    !contents ||
    !parseChromeExtensionUrl(contents.getURL()) ||
    !getBrowserExtensionProfileIdForSession(contents.session)
  ) {
    return null
  }
  const activeId = getActiveBrowserTabId()
  const active = activeId === null ? undefined : webContents.fromId(activeId)
  return active && active.session === contents.session
    ? browserManager.getTabIdForWebContentsId(active.id)
    : null
}

/** Wires cookie, request and content-blocking services into each extension session; restores scripts on load. */
export function installBrowserExtensionSessionServices(): void {
  installBrowserExtensionWebRequestForwarding()
  setBrowserSessionRequestDecider(browserExtensionDnrRequestDecider)
  browserManager.setUnownedDownloadOwnerResolver(resolveExtensionDownloadOwner)
  setBrowserExtensionSessionHooks({
    attached: (sess, profileId, enabledExtensionIds) => {
      observeBrowserExtensionCookieChanges(sess)
      observeBrowserExtensionWebRequests(sess)
      // Why at attach: chrome.action calls create state before any toolbar asks for it.
      observeBrowserExtensionActionSession(sess)
      attachBrowserExtensionDnr(sess, profileId, enabledExtensionIds)
      if (!servedSessions.has(sess)) {
        servedSessions.add(sess)
        sess.extensions.on('extension-unloaded', (_event, extension) => {
          forgetBrowserExtensionContentScriptRestore(sess, extension.id)
          revokeBrowserExtensionActiveTabInSession(sess, extension.id)
        })
      }
    },
    uninstalled: (profileId, extensionIds) => {
      const removeIds = (byProfile: Record<string, string[]>) => ({
        ...byProfile,
        [profileId]: (byProfile[profileId] ?? []).filter((id) => !extensionIds.has(id))
      })
      if (extensionIds.size > 0) {
        browserSessionRegistry.updateEnabledExtensionIds(removeIds)
        browserSessionRegistry.updatePinnedExtensionIds(removeIds)
        if (
          [
            ...browserSessionRegistry.getEnabledExtensionIds(profileId),
            ...browserSessionRegistry.getPinnedExtensionIds(profileId)
          ].some((id) => extensionIds.has(id))
        ) {
          throw new Error('Could not remove stale browser extension enablement')
        }
      }
    },
    detached: stopObservingBrowserExtensionWebRequests,
    loaded: async (sess, profileId, extension) => {
      await Promise.all([
        restoreBrowserExtensionContentScripts(
          sess,
          profileId,
          extension,
          CONTENT_SCRIPT_RESTORE_TIMEOUT_MS
        ),
        whenBrowserExtensionDnrLoaded(sess)
      ])
    }
  })
}
