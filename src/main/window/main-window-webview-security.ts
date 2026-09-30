import type { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { browserManager } from '../browser/browser-manager'
import {
  attachBrowserPageGuestPolicies,
  hardenBrowserPageGuestPreferences,
  isAdmissibleBrowserPageGuest
} from '../browser/browser-page-guest-admission'
import { DOC_PREVIEW_PARTITION, parseDocPreviewUrl } from '../../shared/doc-preview-scheme'
import { setDocPreviewFailureSink } from '../browser/doc-preview-failure-notice'
import {
  getDocPreviewGrant,
  revokeAllDocPreviewGrants
} from '../browser/doc-preview-grant-registry'
import { isDocPreviewSession } from '../browser/doc-preview-protocol'
import { registerHostFrameNavigationGuard } from './host-frame-navigation-guard'
import { installPrivilegedWindowNavigationPolicy } from './privileged-window-navigation'

/**
 * Why a separate admission rule: `normalizeBrowserNavigationUrl` answers only for
 * http(s) and `file:`, so `orca-preview://` can only ever attach here — and only
 * on the doc-preview partition, carrying a grant the main process minted for a
 * deliberate user preview action. Web content has no way to reach either.
 */
function isAdmissibleDocPreviewAttach(partition: string, src: string): boolean {
  if (partition !== DOC_PREVIEW_PARTITION) {
    return false
  }
  const target = parseDocPreviewUrl(src)
  return target !== null && getDocPreviewGrant(target.grantId) !== null
}

export function installMainWindowWebviewSecurity(mainWindow: BrowserWindow): void {
  installPrivilegedWindowNavigationPolicy(mainWindow.webContents)
  // Why here and on every fresh shell document: the renderer holds the only record of which
  // preview owns which grant, and a reload throws that record away. Grants it can no longer
  // release would stay live read authorities for the rest of the process.
  revokeAllDocPreviewGrants()
  mainWindow.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) {
      revokeAllDocPreviewGrants()
    }
  })
  // Why these contents and not the window: every live preview is a guest of this WebContents, and
  // it is also the failure sink itself — once it is destroyed no grant it minted has a reader left.
  mainWindow.webContents.on('destroyed', () => {
    setDocPreviewFailureSink(null)
    revokeAllDocPreviewGrants()
  })
  // Why: containment must be listening before any plugin panel or chat visual frame is
  // created, so register it with the window's other navigation policy.
  registerHostFrameNavigationGuard(mainWindow.webContents)

  const browserPageGuestPreload = join(__dirname, 'browser-page-guest-preload.js')
  // Why a preview gets a preload at all: it is our own editor surface, not a browsing guest. This
  // one only decides what a click on a link means, and it is pinned here so no renderer-supplied
  // value can reach a preview guest and no other attach path can acquire it.
  const docPreviewLinkPreload = join(__dirname, 'doc-preview-link-preload.js')
  mainWindow.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    const src = typeof params.src === 'string' ? params.src : ''
    const partition = typeof webPreferences.partition === 'string' ? webPreferences.partition : ''
    const isDocPreviewAttach = isAdmissibleDocPreviewAttach(partition, src)

    // Why: fail closed — deny any src or partition not in the registry allowlist so a renderer bug can't smuggle preload/Node into an unprivileged guest.
    if (!isDocPreviewAttach && !isAdmissibleBrowserPageGuest(partition, src)) {
      event.preventDefault()
      return
    }

    delete params.preload
    // Why: keep the registry-validated partition so isolated session profiles use their own storage while other hardening stays intact.
    hardenBrowserPageGuestPreferences(
      webPreferences,
      partition,
      isDocPreviewAttach ? docPreviewLinkPreload : browserPageGuestPreload
    )
  })

  mainWindow.webContents.on('did-attach-webview', (_event, guest) => {
    if (isDocPreviewSession(guest.session)) {
      // Why: preview guests never join browser-tab routing, popups or auth-identity tracking; the
      // workspace-doc profile is what refuses all three. The attach is also the point a live window
      // exists to receive read failures for that guest.
      setDocPreviewFailureSink(mainWindow.webContents)
      browserManager.attachGuestPolicies(guest, null, {
        profile: 'workspace-doc',
        host: mainWindow.webContents
      })
      return
    }
    attachBrowserPageGuestPolicies(guest)
  })
}
