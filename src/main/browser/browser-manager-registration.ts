import { webContents } from 'electron'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { isWorkspaceDocPageId } from './doc-preview-guest-policy'
import type { BrowserGuestRegistration } from './browser-manager-types'
import { BrowserManagerGuestPolicy } from './browser-manager-guest-policy'
import {
  cancelBrowserPagePrompts,
  showBrowserPagePromptsAwaitingRegistration
} from './browser-page-prompts'

export abstract class BrowserManagerRegistration extends BrowserManagerGuestPolicy {
  registerGuest(
    {
      browserPageId,
      browserTabId: legacyBrowserTabId,
      workspaceId,
      worktreeId,
      sessionProfileId,
      webContentsId,
      rendererWebContentsId
    }: BrowserGuestRegistration,
    options?: { retainPreviousGuestPolicies?: boolean }
  ): boolean {
    const browserTabId = browserPageId ?? legacyBrowserTabId
    // Keep document IDs out of browsing maps: tool authorization checks documents first.
    if (!browserTabId || isWorkspaceDocPageId(browserTabId)) {
      return false
    }
    // Cancel grabs bound to the previous surface before replacing its guest.
    this.cancelGrabOp(browserTabId, 'evicted')

    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }

    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }

    // Renderer-supplied IDs may name privileged windows; accept only webviews.
    if (guest.getType() !== 'webview') {
      return false
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Trust only webviews that passed attach-time policy installation.
      return false
    }

    const previousWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      if (options?.retainPreviousGuestPolicies) {
        // A staged swap must be able to restore this still-live guest on failure.
        this.tabIdByWebContentsId.delete(previousWebContentsId)
      } else {
        this.retireStaleGuestWebContents(previousWebContentsId)
      }
      this.viewportPresetByTabId.delete(browserTabId)
      this.viewportScrollStateByTabId.delete(browserTabId)
    }
    this.webContentsIdByTabId.set(browserTabId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserTabId)
    if (workspaceId) {
      this.workspaceIdByPageId.set(browserTabId, workspaceId)
    }
    this.sessionProfileIdByPageId.set(browserTabId, sessionProfileId ?? null)
    this.rendererWebContentsIdByTabId.set(browserTabId, rendererWebContentsId)
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserTabId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserTabId)
    this.siteDisplayController?.onGuestRegistered(guest, sessionProfileId ?? null)

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.setupMouseWheelZoomForwarding(browserTabId, guest)
    this.flushPendingLoadFailure(browserTabId, webContentsId)
    this.flushPendingPermissionEvents(browserTabId, webContentsId)
    this.flushPendingPopupEvents(browserTabId, webContentsId)
    this.flushPendingDownloadRequests(browserTabId, webContentsId)
    showBrowserPagePromptsAwaitingRegistration(
      webContentsId,
      this.getRendererContextForGuest(webContentsId)
    )
    return true
  }

  unregisterGuest(
    browserTabId: string,
    reason: 'page-closed' | 'guest-destroyed' = 'page-closed'
  ): void {
    // Document pages retire by grant revocation; this path must not cancel their grabs.
    if (isWorkspaceDocPageId(browserTabId)) {
      return
    }
    // Resolve pending grabs before removing their registration.
    this.cancelGrabOp(browserTabId, 'evicted')
    cancelBrowserPagePrompts(browserTabId)

    const guestWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (guestWebContentsId !== undefined) {
      this.cleanupGuestPolicyAttachment(guestWebContentsId)
    }

    const cleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (cleanup) {
      cleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    const shortcutCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (shortcutCleanup) {
      shortcutCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }
    const fwdCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (fwdCleanup) {
      fwdCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }
    const mouseWheelZoomCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (mouseWheelZoomCleanup) {
      mouseWheelZoomCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }
    let hasActiveDownloads = false
    for (const [downloadId, download] of this.downloadsById.entries()) {
      if (download.browserTabId === browserTabId && !download.terminalEvent) {
        if (reason === 'page-closed') {
          this.cancelDownloadInternal(downloadId, 'Tab closed before download completed.')
        } else {
          hasActiveDownloads = true
        }
      }
    }
    const wcId = this.webContentsIdByTabId.get(browserTabId)
    if (wcId !== undefined) {
      this.tabIdByWebContentsId.delete(wcId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
    // A destroyed guest can recover in an open page while its downloads still report progress.
    if (!hasActiveDownloads) {
      this.rendererWebContentsIdByTabId.delete(browserTabId)
    }
    this.workspaceIdByPageId.delete(browserTabId)
    this.sessionProfileIdByPageId.delete(browserTabId)
    this.worktreeIdByTabId.delete(browserTabId)
    this.viewportOpsByTabId.delete(browserTabId)
    this.viewportPresetByTabId.delete(browserTabId)
    this.viewportScrollStateByTabId.delete(browserTabId)
    if (wcId !== undefined) {
      this.pendingNavigationByGuestId.delete(wcId)
    }
    this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
  }

  // Headless serve uses offscreen contents without renderer webview bindings.
  registerOffscreenGuest({
    browserPageId,
    worktreeId,
    sessionProfileId,
    webContentsId
  }: {
    browserPageId: string
    worktreeId?: string
    sessionProfileId?: string | null
    webContentsId: number
  }): boolean {
    if (isWorkspaceDocPageId(browserPageId)) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }
    // Main owns load-failure reporting for pages without renderer listeners.
    this.offscreenGuestIds.add(webContentsId)
    this.attachGuestPolicies(guest)
    const previousWebContentsId = this.webContentsIdByTabId.get(browserPageId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
      this.viewportPresetByTabId.delete(browserPageId)
      this.viewportScrollStateByTabId.delete(browserPageId)
    }
    this.webContentsIdByTabId.set(browserPageId, webContentsId)
    this.tabIdByWebContentsId.set(webContentsId, browserPageId)
    this.sessionProfileIdByPageId.set(browserPageId, sessionProfileId ?? null)
    if (worktreeId) {
      this.worktreeIdByTabId.set(browserPageId, worktreeId)
    }
    this.certificateTrustController?.onGuestRegistered(webContentsId, browserPageId)
    return true
  }

  unregisterAll(): void {
    this.grabSessionController.cancelAll('evicted')
    for (const downloadId of this.downloadsById.keys()) {
      this.cancelDownloadInternal(downloadId, 'Orca is shutting down.')
    }
    browserDownloadDestinationReservations.clear()
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
    this.offscreenGuestIds.clear()
    // Also clean up guests attached before registration.
    for (const cleanup of this.policyCleanupByGuestId.values()) {
      cleanup()
    }
    this.policyCleanupByGuestId.clear()
    this.tabIdByWebContentsId.clear()
    this.popupOwnerContextByGuestId.clear()
    this.pageInitiatedTabBudgetByRootGuestId.clear()
    this.worktreeIdByTabId.clear()
    this.sessionProfileIdByPageId.clear()
    this.viewportPresetByTabId.clear()
    this.viewportScrollStateByTabId.clear()
    this.cdpUserAgentOverrideStateByGuestId.clear()
    this.pendingNavigationByGuestId.clear()
    this.pendingLoadFailuresByGuestId.clear()
    this.loadErrorsByGuestId.clear()
    this.clearedLoadErrorsByGuestId.clear()
    this.pendingPermissionEventsByGuestId.clear()
    this.pendingPopupEventsByGuestId.clear()
    this.pendingDownloadIdsByGuestId.clear()
    this.mouseWheelZoomCleanupByTabId.clear()
    this.annotationViewportBridgeOpsByTabId.clear()
  }
}
