import { forgetBrowserExtensionSessionContentScripts } from '../api-runtime/browser-extension-content-scripts'
import { clearBrowserExtensionDnrSessionRules } from '../declarative-net-request/session/browser-extension-dnr-session'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import {
  forgetBrowserExtensionSessionStorageSnapshot,
  restoreBrowserExtensionSessionStorage,
  snapshotBrowserExtensionSessionStorage
} from '../profile-storage/browser-extension-session-storage-snapshot'
import { forgetSidePanelExtensionOptions } from '../side-panel/browser-extension-side-panel-options'
import {
  claimBrowserExtensionIdleState,
  dropBrowserExtensionIdleState,
  isBrowserExtensionStateKeptWhileIdle,
  onBrowserExtensionIdleStateDropped,
  startBrowserExtensionCleanAfterIdle
} from './browser-extension-idle-kept-state'
import { fireRuntimeLifecycleEvents } from './browser-extension-runtime-lifecycle'

/** What an extension set for this run that a reattach after an idle unload keeps. */
export function forgetBrowserExtensionSessionState(profileId: string, extensionId: string): void {
  forgetSidePanelExtensionOptions(profileId, extensionId)
  forgetBrowserExtensionSessionContentScripts(profileId, extensionId)
  forgetBrowserExtensionSessionStorageSnapshot(profileId, extensionId)
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
 * Before an idle unload removes them: an extension whose session storage can't be kept (or that
 * loaded after the unload began) loses its other session state too, so onStartup rebuilds it all.
 */
export async function keepBrowserExtensionSessionsWhileIdle(
  sess: Electron.Session,
  profileId: string,
  extensions: readonly Electron.Extension[]
): Promise<void> {
  await Promise.all(
    extensions.map(async (extension) => {
      if (
        isBrowserExtensionStateKeptWhileIdle(profileId, extension.id) &&
        (await snapshotBrowserExtensionSessionStorage(sess, profileId, extension))
      ) {
        return
      }
      startBrowserExtensionCleanAfterIdle(profileId, extension.id)
      getBrowserExtensionDnrStore().writeSessionRules(profileId, extension, [])
    })
  )
}

/**
 * After a reattach loads the extension, before its restored pages: session storage goes back first.
 * If that fails, the extension starts clean instead, with onStartup, as after a browser restart.
 */
export async function resumeBrowserExtensionAfterIdle(
  sess: Electron.Session,
  profileId: string,
  extension: Electron.Extension
): Promise<void> {
  if (await restoreBrowserExtensionSessionStorage(sess, profileId, extension)) {
    claimBrowserExtensionIdleState(profileId, extension.id)
    return
  }
  dropBrowserExtensionIdleState({ profileId, extensionId: extension.id })
  await clearBrowserExtensionDnrSessionRules(sess, extension)
  fireRuntimeLifecycleEvents(sess, profileId, extension, 'startup')
}
