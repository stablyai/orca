import type { WebContents, WebPreferences } from 'electron'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { browserManager } from './browser-manager'
import { browserSessionRegistry } from './browser-session-registry'
import {
  enforceLocalSshWebRtcPolicyForGuest,
  isLocalSshBrowserPartition
} from './local-ssh-browser-partitions'
import {
  browserRouteSessionRegistry,
  browserRouteWebContentsRegistry
} from './browser-route-session-runtime'

// Why one module: a browser page reaches main either as a <webview> attach or as an offscreen
// page the renderer asks for. Both must pass the same partition allowlist and get the same
// hardened preferences and policies, or the second door becomes the weaker one.

/** Whether a renderer-supplied page partition and first URL may back a browser page. */
export function isAdmissibleBrowserPageGuest(partition: string, src: string): boolean {
  const normalizedSrc = normalizeBrowserNavigationUrl(src)
  if (!normalizedSrc) {
    return false
  }
  const isRoutePartition = browserRouteSessionRegistry.isAllowedPartition(partition)
  // Why: local direct-SSH partitions exist only after their proxy is verified, so admission can
  // never race an unproxied session. They navigate like profile partitions.
  const isAllowed =
    browserSessionRegistry.isAllowedPartition(partition) ||
    isRoutePartition ||
    isLocalSshBrowserPartition(partition)
  // Why: route guests stay blank until main-owned registration navigates them.
  return isAllowed && (!isRoutePartition || normalizedSrc === ORCA_BROWSER_BLANK_URL)
}

/** Overwrites every security-relevant preference, keeping only the validated partition. */
export function hardenBrowserPageGuestPreferences(
  webPreferences: WebPreferences,
  partition: string,
  closeWindowPreloadPath: string
): void {
  // Why: preload runs in the page's main world before inline scripts can call window.close().
  webPreferences.preload = closeWindowPreloadPath
  // Why: older Electron builds expose preloadURL alongside preload; delete both so the guest can't inherit the main preload bridge.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: preloadURL is an undeclared legacy key; deleting an absent key is a no-op.
  delete (webPreferences as Record<string, unknown>).preloadURL
  // Why: Electron 43 does not pass the embedder's additionalArguments to a guest; cleared as insurance.
  delete webPreferences.additionalArguments
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.enableBlinkFeatures = ''
  webPreferences.disableBlinkFeatures = ''
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  // Why: force the browser guest policy even if host markup omits or misspells a preference.
  Object.assign(webPreferences, ORCA_BROWSER_GUEST_WEB_PREFERENCES)
  webPreferences.partition = partition
}

/** Installs creation-time policies; must run before the page's first navigation. */
export function attachBrowserPageGuestPolicies(guest: WebContents): void {
  // Why: attach popup/nav policy at creation; waiting for registration races target=_blank/early redirects past it.
  browserManager.attachGuestPolicies(guest)
  // Why: route guests override the generic popup fallback and stay blank until exact main-owned registration.
  browserRouteWebContentsRegistry.attachGuest(guest)
  // Why: the session proxy cannot stop WebRTC UDP; only the per-contents policy does.
  enforceLocalSshWebRtcPolicyForGuest(guest)
}
