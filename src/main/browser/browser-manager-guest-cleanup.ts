import { BrowserManagerGuestNavigationPolicy } from './browser-manager-guest-navigation-policy'

export abstract class BrowserManagerGuestCleanup extends BrowserManagerGuestNavigationPolicy {
  protected retireStaleGuestWebContents(previousWebContentsId: number): void {
    // Why: after a renderer-process swap, stop the dead guest id resolving to the live page so stale callbacks don't hit the wrong session.
    this.cleanupGuestPolicyAttachment(previousWebContentsId)
  }

  protected cleanupGuestPolicyAttachment(guestWebContentsId: number): void {
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    const isPrimaryGuest = browserTabId !== undefined
    if (browserTabId && this.webContentsIdByTabId.get(browserTabId) === guestWebContentsId) {
      this.webContentsIdByTabId.delete(browserTabId)
    }
    this.tabIdByWebContentsId.delete(guestWebContentsId)
    this.certificateTrustController?.onGuestRetired(guestWebContentsId)
    const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
    if (policyCleanup) {
      policyCleanup()
      this.policyCleanupByGuestId.delete(guestWebContentsId)
    }
    this.policyAttachedGuestIds.delete(guestWebContentsId)
    this.clickedLinkFrameNameByGuestId.delete(guestWebContentsId)
    this.offscreenGuestIds.delete(guestWebContentsId)
    this.popupOwnerContextByGuestId.delete(guestWebContentsId)
    this.pageInitiatedTabBudgetByRootGuestId.delete(guestWebContentsId)
    this.authUserAgentOverrideStateByGuestId.delete(guestWebContentsId)
    this.pendingNavigationByGuestId.delete(guestWebContentsId)
    // Why: a popup must stop inheriting authorization the moment its owner retires, before Chromium destroys the child.
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
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    this.cancelPendingDownloadsForGuest(guestWebContentsId)
  }
}
