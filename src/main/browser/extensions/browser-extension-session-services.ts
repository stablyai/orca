import { webContents } from 'electron'
import { parseChromeExtensionUrl } from '../../../shared/browser-extension-url'
import { browserManager } from '../browser-manager'
import { observeBrowserExtensionCookieChanges } from './api/cookies'
import { getBrowserExtensionProfileIdForSession } from './browser-extension-api-host'
import { getActiveBrowserTabId } from './browser-extension-tab-model'
import {
  forgetBrowserExtensionContentScriptRestore,
  restoreBrowserExtensionContentScripts
} from './api/scripting'
import { setBrowserExtensionSessionHooks } from './browser-extension-session-loader'
import {
  installBrowserExtensionWebRequestForwarding,
  observeBrowserExtensionWebRequests
} from './browser-extension-web-request'

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

/** Wires cookie and request observers into each extension session and restores scripts on load. */
export function installBrowserExtensionSessionServices(): void {
  installBrowserExtensionWebRequestForwarding()
  browserManager.setUnownedDownloadOwnerResolver(resolveExtensionDownloadOwner)
  setBrowserExtensionSessionHooks({
    attached: (sess) => {
      observeBrowserExtensionCookieChanges(sess)
      observeBrowserExtensionWebRequests(sess)
      sess.extensions.on('extension-unloaded', (_event, extension) =>
        forgetBrowserExtensionContentScriptRestore(sess, extension.id)
      )
    },
    loaded: (sess, profileId, extension) =>
      restoreBrowserExtensionContentScripts(
        sess,
        profileId,
        extension,
        CONTENT_SCRIPT_RESTORE_TIMEOUT_MS
      )
  })
}
