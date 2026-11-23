import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { webContents } from 'electron'
import { parseChromeExtensionUrl } from '../../../../shared/browser/extensions/browser-extension-url'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import { observeBrowserExtensionCookieChanges } from '../api/cookies'
import { observeBrowserExtensionActionSession } from '../actions/browser-extension-action-registry'
import { revokeBrowserExtensionActiveTabInSession } from '../permissions/browser-extension-active-tab'
import { getBrowserExtensionProfileIdForSession } from '../api-runtime/browser-extension-api-host'
import { hasBrowserExtensionWorkerCallsInFlight } from '../api-runtime/browser-extension-worker-api-host'
import { getActiveBrowserTabId } from '../tabs-and-windows/browser-extension-tab-model'
import {
  forgetBrowserExtensionContentScriptRestore,
  restoreBrowserExtensionContentScripts
} from '../api-runtime/browser-extension-content-scripts'
import { setBrowserSessionRequestDecider } from '../../sessions/requests/browser-session-request-decisions'
import { browserExtensionDnrRequestDecider } from '../declarative-net-request/session/browser-extension-dnr-requests'
import {
  attachBrowserExtensionDnr,
  whenBrowserExtensionDnrLoaded
} from '../declarative-net-request/session/browser-extension-dnr-session'
import { setBrowserExtensionSessionHooks } from './browser-extension-session-loader'
import {
  forgetBrowserExtensionCleanStartNeed,
  noteBrowserExtensionNeedsCleanStart,
  isBrowserExtensionStateKeptWhileIdle
} from './browser-extension-idle-kept-state'
import {
  forgetBrowserExtensionSessionState,
  installBrowserExtensionIdleResume,
  settleBrowserExtensionResume
} from './browser-extension-idle-resume'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { noteBrowserExtensionsStarting } from './browser-extension-session-presence'
import { closeBrowserExtensionSidePanelsForExtension } from '../side-panel/browser-extension-side-panel-host'
import {
  installBrowserExtensionWebRequestForwarding,
  observeBrowserExtensionWebRequests,
  stopObservingBrowserExtensionWebRequests
} from '../requests/browser-extension-web-request-observer'

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
  installBrowserExtensionIdleResume()
  installBrowserExtensionWebRequestForwarding()
  setBrowserSessionRequestDecider(browserExtensionDnrRequestDecider)
  browserManager.setUnownedDownloadOwnerResolver(resolveExtensionDownloadOwner)
  setBrowserExtensionSessionHooks({
    attached: (sess, profileId, enabledExtensionIds) => {
      // An id with no install never loads, so nothing should wait for it.
      noteBrowserExtensionsStarting(
        sess,
        enabledExtensionIds.filter((id) => getBrowserExtensionInstallStore().get(id))
      )
      observeBrowserExtensionCookieChanges(sess)
      observeBrowserExtensionWebRequests(sess)
      // Why at attach: chrome.action calls create state before any toolbar asks for it.
      observeBrowserExtensionActionSession(sess)
      attachBrowserExtensionDnr(sess, profileId, enabledExtensionIds)
      if (!servedSessions.has(sess)) {
        servedSessions.add(sess)
        sess.extensions.on('extension-loaded', (_event, extension) =>
          forgetBrowserExtensionCleanStartNeed(profileId, extension.id)
        )
        sess.extensions.on('extension-unloaded', (_event, extension) => {
          // Why: a call main was still handling may have changed state the reattach can't see.
          if (hasBrowserExtensionWorkerCallsInFlight(sess, extension.id)) {
            noteBrowserExtensionNeedsCleanStart(profileId, extension.id)
          }
          forgetBrowserExtensionContentScriptRestore(sess, extension.id)
          revokeBrowserExtensionActiveTabInSession(sess, extension.id)
          // Why the attach-time id: deleting a profile forgets its session before unloading.
          closeBrowserExtensionSidePanelsForExtension(profileId, extension.id)
          if (!isBrowserExtensionStateKeptWhileIdle(profileId, extension.id)) {
            forgetBrowserExtensionSessionState(profileId, extension.id)
          }
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
      await settleBrowserExtensionResume(
        sess,
        profileId,
        extension,
        Promise.all([
          restoreBrowserExtensionContentScripts(
            sess,
            profileId,
            extension,
            CONTENT_SCRIPT_RESTORE_TIMEOUT_MS
          ),
          whenBrowserExtensionDnrLoaded(sess)
        ]),
        CONTENT_SCRIPT_RESTORE_TIMEOUT_MS
      )
    }
  })
}
