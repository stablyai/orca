import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  enforceLocalSshWebRtcPolicyForGuest,
  isLocalSshBrowserPartition
} from '../browser/local-ssh-browser-partitions'
import {
  browserRouteSessionRegistry,
  browserRouteWebContentsRegistry
} from '../browser/browser-route-session-runtime'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { registerPluginPanelNavigationGuard } from '../plugins/plugin-panel-navigation-guard'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

export function installMainWindowWebviewSecurity(mainWindow: BrowserWindow): void {
  installPrivilegedWindowNavigationPolicy(mainWindow.webContents)
  // Why: containment must be listening before any plugin panel frame is created,
  // so register it with the window's other navigation policy.
  registerPluginPanelNavigationGuard(mainWindow.webContents)

  const browserWindowClosePreload = join(__dirname, 'browser-window-close-preload.js')
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''
    const isProfilePartition = browserSessionRegistry.isAllowedPartition(partition)
    const isRoutePartition = browserRouteSessionRegistry.isAllowedPartition(partition)
    // Why: local direct-SSH partitions exist only after their proxy is verified,
    // so admission here can never race an unproxied session. They navigate like
    // profile partitions — the renderer owns their URLs, no main-side grants.
    const isLocalSshPartition = isLocalSshBrowserPartition(partition)

    // Why: fail closed — deny any src or partition not in the registry allowlist so a renderer bug can't smuggle preload/Node into an unprivileged guest.
    if (
      !normalizedSrc ||
      (!isProfilePartition && !isRoutePartition && !isLocalSshPartition) ||
      (isRoutePartition && normalizedSrc !== ORCA_BROWSER_BLANK_URL)
    ) {
      event.preventDefault()
      return
    }

    delete params.preload
    // Why: preload runs in the page's main world before inline scripts can call window.close().
    webPreferences.preload = browserWindowClosePreload
    // Why: older Electron builds expose preloadURL alongside preload; delete both so the guest can't inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    // Why delete something Electron does not set: 43 does not pass the embedder's
    // additionalArguments down to a guest, so this clears a key that is absent today. Kept as
    // insurance — if that ever changes, the guest would read this app's browser-host id.
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
    // Why: keep the registry-validated partition so isolated session profiles use their own storage while other hardening stays intact.
    webPreferences.partition = partition
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    // Why: attach guest popup/nav policy at creation; waiting for renderer registration races target=_blank/early redirects past it.
    browserManager.attachGuestPolicies(guest)
    // Why: route guests override the generic popup fallback and stay blank until exact main-owned registration.
    browserRouteWebContentsRegistry.attachGuest(guest)
    // Why: the session proxy cannot stop WebRTC UDP; only the per-contents policy does.
    enforceLocalSshWebRtcPolicyForGuest(guest)
  })
}
