import { forgetBrowserExtensionSessionContentScripts } from '../api-runtime/browser-extension-content-scripts'
import { getBrowserExtensionDnrStore } from '../declarative-net-request/session/browser-extension-dnr-store'
import { forgetSidePanelExtensionOptions } from '../side-panel/browser-extension-side-panel-options'
import {
  dropBrowserExtensionIdleState,
  onBrowserExtensionIdleStateDropped
} from './browser-extension-idle-kept-state'

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
