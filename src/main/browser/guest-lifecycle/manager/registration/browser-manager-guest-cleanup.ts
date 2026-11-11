import { BrowserManagerGuestNavigationPolicy } from '../navigation/browser-manager-guest-navigation-policy'
import { webContents } from 'electron'
import { clearBrowserPageMemoryInvalidation } from '../../browser-page-memory'

export abstract class BrowserManagerGuestCleanup extends BrowserManagerGuestNavigationPolicy {
  protected cleanupGuestPolicyAttachment(guestWebContentsId: number): void {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    const openerId = this.popupOwnerContextByGuestId.get(guestWebContentsId)?.rootGuestWebContentsId
    if (browserTabId) {
      clearBrowserPageMemoryInvalidation(browserTabId, guestWebContentsId)
    }
    const isPrimaryGuest = browserTabId !== undefined
    if (browserTabId && this.webContentsIdByTabId.get(browserTabId) === guestWebContentsId) {
      this.webContentsIdByTabId.delete(browserTabId)
    }
    this.tabIdByWebContentsId.delete(guestWebContentsId)
    this.certificateTrustController?.onGuestRetired(guestWebContentsId)
    this.siteDisplayController?.onGuestRetired(guestWebContentsId)
    const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
    if (policyCleanup) {
      policyCleanup()
      this.policyCleanupByGuestId.delete(guestWebContentsId)
    }
    this.policyAttachedGuestIds.delete(guestWebContentsId)
    this.offscreenGuestIds.delete(guestWebContentsId)
    this.popupOwnerContextByGuestId.delete(guestWebContentsId)
    const opener = openerId === undefined ? null : webContents.fromId(openerId)
    if (opener) {
      this.invalidateGuestMemoryProtection(opener)
    }
    this.pageInitiatedTabBudgetByRootGuestId.delete(guestWebContentsId)
    this.cdpUserAgentOverrideStateByGuestId.delete(guestWebContentsId)
    this.pendingNavigationByGuestId.delete(guestWebContentsId)
    // Revoke popup authorization as soon as the owner retires, before child destruction.
    if (isPrimaryGuest) {
      for (const [popupGuestId, owner] of this.popupOwnerContextByGuestId) {
        if (owner.rootGuestWebContentsId === guestWebContentsId) {
          this.popupOwnerContextByGuestId.delete(popupGuestId)
        }
      }
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.loadErrorsByGuestId.delete(guestWebContentsId)
    this.clearedLoadErrorsByGuestId.delete(guestWebContentsId)
    this.remoteTabFaviconUrlByGuestId.delete(guestWebContentsId)
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    this.cancelPendingDownloadsForGuest(guestWebContentsId)
  }
}
