import {
  forgetBrowserExtensionSessionContentScripts,
  restartBrowserExtensionContentScripts
} from '../api-runtime/browser-extension-content-scripts'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import { forgetSidePanelExtensionOptions } from '../side-panel/browser-extension-side-panel-options'
import { clearBrowserExtensionDnrSessionRules } from '../declarative-net-request/session/browser-extension-dnr-session'
import {
  claimBrowserExtensionIdleState,
  dropBrowserExtensionIdleState,
  isBrowserExtensionResuming,
  onBrowserExtensionIdleStateDropped
} from './browser-extension-idle-kept-state'
import { fireRuntimeLifecycleEvents } from './browser-extension-runtime-lifecycle'

/** What an extension set for this run that a reattach after an idle unload keeps. */
export function forgetBrowserExtensionSessionState(profileId: string, extensionId: string): void {
  forgetSidePanelExtensionOptions(profileId, extensionId)
  forgetBrowserExtensionSessionContentScripts(profileId, extensionId)
}

export function installBrowserExtensionIdleResume(): void {
  onBrowserExtensionIdleStateDropped(forgetBrowserExtensionSessionState)
}

/** Extensions turned off: like a browser quit, every profile's extensions start clean next time. */
export function forgetAllBrowserExtensionSessions(): void {
  dropBrowserExtensionIdleState({})
  getBrowserExtensionDnrStore().forgetAllSessionRules()
}

/**
 * After a reattach loaded the extension and put its state back: a resumed extension whose restore
 * failed partway starts clean instead (kept state and session rules go, onStartup fires).
 */
export async function settleBrowserExtensionResume(
  sess: Electron.Session,
  profileId: string,
  extension: Electron.Extension,
  restore: Promise<unknown>,
  restoreTimeoutMs: number
): Promise<void> {
  try {
    await restore
    claimBrowserExtensionIdleState(profileId, extension.id)
  } catch (error) {
    // Why loaded too: a disable or uninstall during the restore is not a failed resume.
    if (
      !isBrowserExtensionResuming(profileId, extension.id) ||
      !sess.extensions.getExtension(extension.id)
    ) {
      throw error
    }
    console.warn(`[browser-extensions] Could not resume ${extension.id}; starting it clean:`, error)
    dropBrowserExtensionIdleState({ profileId, extensionId: extension.id })
    await Promise.all([
      restartBrowserExtensionContentScripts(sess, profileId, extension, restoreTimeoutMs),
      clearBrowserExtensionDnrSessionRules(sess, extension.id)
    ]).finally(() => fireRuntimeLifecycleEvents(sess, profileId, extension, 'startup'))
  }
}
