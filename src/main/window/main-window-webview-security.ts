import type { BrowserWindow, WebContents } from 'electron'
import { join } from 'node:path'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import { ORCA_BROWSER_GUEST_WEB_PREFERENCES } from '../../shared/browser-guest-web-preferences'
import { normalizeBrowserNavigationUrl } from '../../shared/browser-url'
import { DOC_PREVIEW_PARTITION, parseDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { browserManager } from '../browser/browser-manager'
import {
  browserRouteSessionRegistry,
  browserRouteWebContentsRegistry
} from '../browser/browser-route-session-runtime'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { setDocPreviewFailureSink } from '../browser/doc-preview-failure-notice'
import { isDocPreviewSession } from '../browser/doc-preview-protocol'
import {
  enforceLocalSshWebRtcPolicyForGuest,
  isLocalSshBrowserPartition
} from '../browser/local-ssh-browser-partitions'
import { registerPluginPanelNavigationGuard } from '../plugins/plugin-panel-navigation-guard'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

function isAdmissibleDocPreviewAttach(partition: string, src: string): boolean {
  if (partition !== DOC_PREVIEW_PARTITION) {
    return false
  }
  const target = parseDocPreviewUrl(src)
  return target !== null && getDocPreviewGrant(target.grantId) !== null
}

function installWebviewAttachmentSecurity(contents: WebContents): void {
  const browserWindowClosePreload = join(__dirname, 'browser-window-close-preload.js')
  const docPreviewLinkPreload = join(__dirname, 'doc-preview-link-preload.js')

  contents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const normalizedSrc = normalizeBrowserNavigationUrl(src)
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''
    const isProfilePartition = browserSessionRegistry.isAllowedPartition(partition)
    const isRoutePartition = browserRouteSessionRegistry.isAllowedPartition(partition)
    const isLocalSshPartition = isLocalSshBrowserPartition(partition)
    const isDocPreviewAttach = isAdmissibleDocPreviewAttach(partition, src)

    if (
      !isDocPreviewAttach &&
      (!normalizedSrc ||
        (!isProfilePartition && !isRoutePartition && !isLocalSshPartition) ||
        (isRoutePartition && normalizedSrc !== ORCA_BROWSER_BLANK_URL))
    ) {
      event.preventDefault()
      return
    }

    delete params.preload
    webPreferences.preload = isDocPreviewAttach ? docPreviewLinkPreload : browserWindowClosePreload
    delete (webPreferences as Record<string, unknown>).preloadURL
    delete webPreferences.additionalArguments
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.enableBlinkFeatures = ''
    webPreferences.disableBlinkFeatures = ''
    webPreferences.webSecurity = true
    webPreferences.allowRunningInsecureContent = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    Object.assign(webPreferences, ORCA_BROWSER_GUEST_WEB_PREFERENCES)
    webPreferences.partition = partition
  })

  contents.on('did-attach-webview', (_event, guest) => {
    if (isDocPreviewSession(guest.session)) {
      setDocPreviewFailureSink(contents)
      browserManager.attachGuestPolicies(guest, null, {
        profile: 'workspace-doc',
        host: contents
      })
      return
    }
    browserManager.attachGuestPolicies(guest)
    browserRouteWebContentsRegistry.attachGuest(guest)
    enforceLocalSshWebRtcPolicyForGuest(guest)
  })
}

export function installFloatingWorkspaceWebviewSecurity(childWindow: BrowserWindow): void {
  installPrivilegedWindowNavigationPolicy(childWindow.webContents)
  registerPluginPanelNavigationGuard(childWindow.webContents)
  installWebviewAttachmentSecurity(childWindow.webContents)
}

export function installMainWindowWebviewSecurity(mainWindow: BrowserWindow): void {
  installPrivilegedWindowNavigationPolicy(mainWindow.webContents)
  revokeAllDocPreviewGrants()
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      revokeAllDocPreviewGrants()
    }
  })
  mainWindow.webContents.on('destroyed', () => {
    setDocPreviewFailureSink(null)
    revokeAllDocPreviewGrants()
  })
  registerPluginPanelNavigationGuard(mainWindow.webContents)
  installWebviewAttachmentSecurity(mainWindow.webContents)
}
