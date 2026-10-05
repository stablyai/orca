import { webContents } from 'electron'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { isWorkspaceDocPageId } from './doc-preview-guest-policy'
import type { BrowserGuestRegistration } from './browser-manager-types'
import { BrowserManagerGuestPolicy } from './browser-manager-guest-policy'
import {
  isDesktopOwnedBrowserViewRecord,
  type DesktopOwnedBrowserViewRecord
} from './desktop-owned-browser-view-admission'

type DesktopOwnedViewHost = {
  isDestroyed: () => boolean
  webContents: Pick<Electron.WebContents, 'id' | 'isDestroyed'>
  contentView: { children: Electron.View[] }
}

export abstract class BrowserManagerRegistration extends BrowserManagerGuestPolicy {
  private readonly ownedViewRecordsByPageId = new Map<string, DesktopOwnedBrowserViewRecord>()
  registerGuest({
    browserPageId,
    browserTabId: legacyBrowserTabId,
    workspaceId,
    worktreeId,
    sessionProfileId,
    webContentsId,
    rendererWebContentsId
  }: BrowserGuestRegistration): boolean {
    const browserTabId = browserPageId ?? legacyBrowserTabId
    // Why refuse rather than overwrite: the two halves of the registry must stay disjoint, or one
    // id resolves in both and the tool door silently prefers the document guest over the page.
    if (!browserTabId || isWorkspaceDocPageId(browserTabId)) {
      return false
    }
    if (this.ownedViewRecordsByPageId.has(browserTabId)) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }

    // Why: don't trust the renderer-sent id blindly — a compromised renderer could pass the main window's id; only accept webview guests.
    if (guest.getType() !== 'webview') {
      return false
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Why: only trust guests that passed attach-time policy install, or a renderer could point us at an arbitrary webview.
      return false
    }

    // Why: an invalid registration must not evict listeners belonging to a live page.
    this.cancelGrabOp(browserTabId, 'evicted')
    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    this.installVerifiedGuestRegistration({
      browserTabId,
      workspaceId,
      worktreeId,
      sessionProfileId,
      webContentsId,
      rendererWebContentsId,
      guest
    })
    return true
  }

  registerOwnedView(
    record: DesktopOwnedBrowserViewRecord,
    currentOwner: DesktopOwnedViewHost,
    container?: Electron.View
  ): boolean {
    if (
      !isDesktopOwnedBrowserViewRecord(record) ||
      currentOwner.isDestroyed() ||
      currentOwner.webContents.isDestroyed() ||
      currentOwner.webContents.id !== record.rendererWebContentsId ||
      record.webContents.isDestroyed() ||
      record.view.webContents !== record.webContents ||
      record.webContents.session !== record.session ||
      !(container
        ? currentOwner.contentView.children.includes(container) &&
          container.children.includes(record.view)
        : currentOwner.contentView.children.includes(record.view)) ||
      !this.policyAttachedGuestIds.has(record.webContents.id) ||
      isWorkspaceDocPageId(record.browserPageId)
    ) {
      return false
    }
    const previousId = this.webContentsIdByTabId.get(record.browserPageId)
    const previousPage = this.tabIdByWebContentsId.get(record.webContents.id)
    if (
      (previousId !== undefined && previousId !== record.webContents.id) ||
      (previousPage !== undefined && previousPage !== record.browserPageId)
    ) {
      return false
    }
    this.cancelGrabOp(record.browserPageId, 'evicted')
    const previousCleanup = this.contextMenuCleanupByTabId.get(record.browserPageId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(record.browserPageId)
    }
    this.installVerifiedGuestRegistration({
      browserTabId: record.browserPageId,
      workspaceId: record.workspaceId,
      worktreeId: record.worktreeId,
      sessionProfileId: record.sessionProfileId,
      webContentsId: record.webContents.id,
      rendererWebContentsId: record.rendererWebContentsId,
      guest: record.webContents
    })
    this.ownedViewRecordsByPageId.set(record.browserPageId, record)
    return true
  }

  isOwnedViewPage(browserPageId: string): boolean {
    return this.ownedViewRecordsByPageId.has(browserPageId)
  }

  protected installVerifiedGuestRegistration({
    browserTabId,
    workspaceId,
    worktreeId,
    sessionProfileId,
    webContentsId,
    rendererWebContentsId,
    guest
  }: {
    browserTabId: string
    workspaceId?: string
    worktreeId?: string
    sessionProfileId?: string | null
    webContentsId: number
    rendererWebContentsId: number
    guest: Electron.WebContents
  }): void {
    const previousWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (previousWebContentsId !== undefined && previousWebContentsId !== webContentsId) {
      this.retireStaleGuestWebContents(previousWebContentsId)
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

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.setupMouseWheelZoomForwarding(browserTabId, guest)
    this.flushPendingLoadFailure(browserTabId, webContentsId)
    this.flushPendingPermissionEvents(browserTabId, webContentsId)
    this.flushPendingPopupEvents(browserTabId, webContentsId)
    this.flushPendingDownloadRequests(browserTabId, webContentsId)
  }

  unregisterGuest(
    browserTabId: string,
    reason: 'page-closed' | 'guest-destroyed' = 'page-closed'
  ): void {
    // Why the check on the exit door too: a document page withdraws by revoking its grant, never
    // through here, so its id arriving is misaddressed — and the cancel below would evict that
    // preview's live grab on the strength of it.
    if (isWorkspaceDocPageId(browserTabId)) {
      return
    }
    this.ownedViewRecordsByPageId.delete(browserTabId)
    // Why: teardown mid-grab must cancel it so the renderer gets a signal, not a dangling Promise.
    this.cancelGrabOp(browserTabId, 'evicted')

    // Why: remove attachGuestPolicies listeners so their guest-WebContents closures don't block GC.
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
    // Why: drop the viewport-op chain so the Map doesn't retain a promise keyed to a destroyed guest.
    this.viewportOpsByTabId.delete(browserTabId)
    this.viewportPresetByTabId.delete(browserTabId)
    this.viewportScrollStateByTabId.delete(browserTabId)
    if (wcId !== undefined) {
      this.pendingNavigationByGuestId.delete(wcId)
    }
    this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
  }

  // Why: headless orca serve has no <webview> window; back pages with offscreen WebContents and skip the webview-only setup.
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
    // Why the same check on both registration doors: one id resolving in both halves is the exact
    // confusion the split registries exist to prevent.
    if (isWorkspaceDocPageId(browserPageId)) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return false
    }
    // Why: offscreen pages have no renderer webview listeners, so main owns their load-failure lifecycle.
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
    // Cancel all active grab ops before tearing down registrations
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
    // Why: unregisterGuest skips guests that were policy-attached but never registered; invoke their cleanup closures here.
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
