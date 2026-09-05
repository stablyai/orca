import { randomUUID } from 'node:crypto'
import {
  BROWSING_GUEST_POLICY,
  type BrowserGuestPolicy,
  type PopupOwnerContext
} from './browser-manager-types'
import { BrowserManagerGuestCleanup } from './browser-manager-guest-cleanup'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'

export abstract class BrowserManagerGuestPolicy extends BrowserManagerGuestCleanup {
  attachGuestPolicies(
    guest: Electron.WebContents,
    inheritedOwnerContext: PopupOwnerContext | null = null,
    policy: BrowserGuestPolicy = BROWSING_GUEST_POLICY
  ): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    // Why one door with a profile rather than a second installer beside it: whether a guest was
    // policy-attached at all is what registration and teardown both key on, so a guest that took
    // another path into the app is invisible to both.
    if (policy.profile === 'workspace-doc') {
      this.attachWorkspaceDocGuestPolicies(guest, policy.host)
      return
    }
    if (inheritedOwnerContext) {
      this.popupOwnerContextByGuestId.set(guest.id, inheritedOwnerContext)
    }
    // Why: only the primary embedded browser converts new-tab clicks to Orca tabs; OAuth child windows keep native link behavior.
    const clickedLinkFrameName = inheritedOwnerContext
      ? null
      : `__orca_clicked_link_foreground_${randomUUID()}`
    if (clickedLinkFrameName) {
      this.clickedLinkFrameNameByGuestId.set(guest.id, clickedLinkFrameName)
    }

    // Why: bot detectors probe APIs that differ in Electron webviews; inject overrides each load so manual browsing passes.
    const disposeAntiDetection = this.injectAntiDetection(guest)
    // Why: disable throttling so background screenshots still get frames; else the compositor stalls and capture returns empty.
    guest.setBackgroundThrottling(false)
    const disposePopupPolicy = this.installGuestPopupPolicy(guest, clickedLinkFrameName)
    const disposeNavigationPolicy = this.installGuestNavigationPolicy(guest)

    // Why: store cleanup so unregisterGuest can drop these listeners on teardown and let the WebContents wrapper GC.
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeAntiDetection()
      disposePopupPolicy()
      disposeNavigationPolicy()
    })
  }

  /**
   * A workspace document is not the web: no popups, no link routing, no anti-detection, and no
   * navigation bookkeeping for chrome it does not have. What it does share with a browsing guest is
   * this method's teardown, so a retired preview drops its listeners on the same path.
   */
  protected attachWorkspaceDocGuestPolicies(
    guest: Electron.WebContents,
    host: Electron.WebContents
  ): void {
    const disposeDocPolicy = installDocPreviewGuestPolicy(guest, host)
    const handleDestroyed = (): void => {
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDocPolicy()
      try {
        guest.off('destroyed', handleDestroyed)
      } catch {
        // guest may already be destroyed
      }
    })
  }
}
