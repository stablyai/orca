import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { browserManager } from '../browser/browser-manager'
import { browserSessionRegistry } from '../browser/browser-session-registry'
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

    // Why: fail closed — deny any src or partition not in the registry allowlist so a renderer bug can't smuggle preload/Node into an unprivileged guest.
    if (!normalizedSrc || !browserSessionRegistry.isAllowedPartition(partition)) {
      event.preventDefault()
      return
    }

    delete params.preload
    // Why: preload runs in the page's main world before inline scripts can call window.close().
    webPreferences.preload = browserWindowClosePreload
    // Why: older Electron builds expose preloadURL alongside preload; delete both so the guest can't inherit the main preload bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
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
  })
}
