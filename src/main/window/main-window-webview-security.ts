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
import { DOC_PREVIEW_PARTITION, parseDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { setDocPreviewFailureSink } from '../browser/doc-preview-failure-notice'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { isDocPreviewSession } from '../browser/doc-preview-protocol'
import { registerHostFrameNavigationGuard } from './host-frame-navigation-guard'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'
import { parseChromeExtensionUrl } from '../../shared/browser-extension-url'
import { getBrowserExtensionSessionForProfile } from '../browser/extensions/browser-extension-session-loader'

/** orca-preview is outside normal browser URL admission; require the doc partition and a main-minted user-preview grant. */
function isAdmissibleDocPreviewAttach(partition: string, src: string): boolean {
  if (partition !== DOC_PREVIEW_PARTITION) {
    return false
  }
  const target = parseDocPreviewUrl(src)
  return target !== null && getDocPreviewGrant(target.grantId) !== null
}

/**
 * Why its own rule: extension pages (options, tabs.create) are not typed URLs, so they attach only
 * in a local browser-profile partition whose session has that extension loaded — i.e. installed
 * and enabled for that profile. Route, SSH and doc-preview partitions never qualify.
 */
function isAdmissibleExtensionPageAttach(partition: string, src: string): boolean {
  const extensionUrl = parseChromeExtensionUrl(src)
  if (!extensionUrl || !browserSessionRegistry.isAllowedPartition(partition)) {
    return false
  }
  const profile = browserSessionRegistry.listProfiles().find((p) => p.partition === partition)
  const sess = profile ? getBrowserExtensionSessionForProfile(profile.id) : null
  return Boolean(sess?.extensions.getExtension(extensionUrl.extensionId))
}

export function installMainWindowWebviewSecurity(mainWindow: BrowserWindow): void {
  installPrivilegedWindowNavigationPolicy(mainWindow.webContents)
  // Why: plugin panels are frames of this renderer; same IP-handling fence as doc preview guests.
  mainWindow.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
  // Why here and on every fresh shell document: the renderer holds the only record of which
  // preview owns which grant, and a reload throws that record away. Grants it can no longer
  // release would stay live read authorities for the rest of the process.
  revokeAllDocPreviewGrants()
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      revokeAllDocPreviewGrants()
    }
  })
  // These WebContents own every preview and its failure sink; destruction leaves no readers.
  mainWindow.webContents.on('destroyed', () => {
    setDocPreviewFailureSink(null)
    revokeAllDocPreviewGrants()
  })
  // Install containment before any plugin/chat srcdoc frame is created.
  registerHostFrameNavigationGuard(mainWindow.webContents)

  const browserWindowClosePreload = join(__dirname, 'browser-window-close-preload.js')
  // Only previews get this pinned editor-link preload; never accept renderer preload values or expose it to browsing guests.
  const docPreviewLinkPreload = join(__dirname, 'doc-preview-link-preload.js')
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''
    const isProfilePartition = browserSessionRegistry.isAllowedPartition(partition)
    const isRoutePartition = browserRouteSessionRegistry.isAllowedPartition(partition)
    // Direct-SSH partitions exist only after proxy verification; renderer URLs need no main-side grants, like profile partitions.
    const isLocalSshPartition = isLocalSshBrowserPartition(partition)
    const isDocPreviewAttach = isAdmissibleDocPreviewAttach(partition, src)
    const isExtensionPageAttach = isAdmissibleExtensionPageAttach(partition, src)

    // Require an allowlisted src/partition; renderer mistakes must not grant preload/Node authority.
    if (
      !isDocPreviewAttach &&
      !isExtensionPageAttach &&
      (!normalizedSrc ||
        (!isProfilePartition && !isRoutePartition && !isLocalSshPartition) ||
        (isRoutePartition && normalizedSrc !== ORCA_BROWSER_BLANK_URL))
    ) {
      event.preventDefault()
      return
    }

    delete params.preload
    // Install main-world close policy before inline scripts can call window.close.
    webPreferences.preload = isDocPreviewAttach ? docPreviewLinkPreload : browserWindowClosePreload
    // Clear legacy preloadURL as well as preload so guests cannot inherit the main bridge.
    delete (webPreferences as Record<string, unknown>).preloadURL
    // Electron 43 omits inherited arguments; clear defensively so future inheritance cannot leak browser-host identity.
    delete webPreferences.additionalArguments
    webPreferences.nodeIntegration = false
    // Why every local profile: a framed extension page needs Orca's extension preload, and
    // extensions can be switched on after the tab opens. Sandboxed and without Node, the flag only
    // runs the same preloads per frame; the close guard keeps to the top frame and the extension
    // preload, registered only while extensions run, acts only in chrome-extension:// frames.
    webPreferences.nodeIntegrationInSubFrames = isProfilePartition
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Force hardened guest preferences even if host markup omits/misspells them.
    Object.assign(webPreferences, ORCA_BROWSER_GUEST_WEB_PREFERENCES)
    // Preserve only the registry-validated partition so isolated profiles keep their storage.
    webPreferences.partition = partition
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    if (isDocPreviewSession(guest.session)) {
      // workspace-doc guests cannot use browser routing/popups/auth identity; attach this live host as their read-failure sink.
      setDocPreviewFailureSink(mainWindow.webContents)
      browserManager.attachGuestPolicies(guest, null, {
        profile: 'workspace-doc',
        host: mainWindow.webContents
      })
      return
    }
    // Install popup/navigation policy at creation or early redirects/target=_blank can outrun registration.
    browserManager.attachGuestPolicies(guest)
    // Route guests stay blank until exact main-owned registration and override generic popup routing.
    browserRouteWebContentsRegistry.attachGuest(guest)
    // Proxies cannot block WebRTC UDP; enforce it per WebContents.
    enforceLocalSshWebRtcPolicyForGuest(guest)
  })
}
