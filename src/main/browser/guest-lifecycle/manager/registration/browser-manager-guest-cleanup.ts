import { BrowserManagerGuestNavigationPolicy } from '../navigation/browser-manager-guest-navigation-policy'
import { webContents } from 'electron'
import { clearBrowserPageMemoryInvalidation } from '../../browser-page-memory'

export abstract class BrowserManagerGuestCleanup extends BrowserManagerGuestNavigationPolicy {
  protected completeGuestCleanup(stage: string, cleanup: () => void): void {
    try {
      cleanup()
    } catch {
      console.warn('[BrowserManager] Guest cleanup failed:', stage)
    }
  }

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
    const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
    this.policyCleanupByGuestId.delete(guestWebContentsId)
    this.policyAttachedGuestIds.delete(guestWebContentsId)
    this.offscreenGuestIds.delete(guestWebContentsId)
    this.popupOwnerContextByGuestId.delete(guestWebContentsId)
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
    this.completeGuestCleanup('certificate trust', () =>
      this.certificateTrustController?.onGuestRetired(guestWebContentsId)
    )
    this.completeGuestCleanup('site display', () =>
      this.siteDisplayController?.onGuestRetired(guestWebContentsId)
    )
    this.completeGuestCleanup('policies', () => policyCleanup?.())
    this.completeGuestCleanup('popup opener', () => {
      const opener = openerId === undefined ? null : webContents.fromId(openerId)
      if (opener) {
        this.invalidateGuestMemoryProtection(opener)
      }
    })
    this.completeGuestCleanup('pending downloads', () =>
      this.cancelPendingDownloadsForGuest(guestWebContentsId)
    )
  }
}
