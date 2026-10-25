import {
  BROWSING_GUEST_POLICY,
  type BrowserGuestPolicy,
  type PopupOwnerContext
} from './browser-manager-types'
import { BrowserManagerGuestCleanup } from './browser-manager-guest-cleanup'
import { allowPageUnload } from './browser-guest-unload-policy'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { installGuestDevToolsWindowBehavior } from './browser-guest-devtools-window'

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
    // All profiles share attachment bookkeeping used by registration and teardown.
    if (policy.profile === 'workspace-doc') {
      this.attachWorkspaceDocGuestPolicies(guest, policy.host)
      return
    }
    if (inheritedOwnerContext) {
      this.popupOwnerContextByGuestId.set(guest.id, inheritedOwnerContext)
    }
    const disposeDetachTracking = this.trackDebuggerDetachForCdpOverrides(guest)
    // Keep background compositor frames available for screenshots.
    guest.setBackgroundThrottling(false)
    const disposePopupPolicy = this.installGuestPopupPolicy(guest)
    const disposeNavigationPolicy = this.installGuestNavigationPolicy(guest)
    const forwardAudioState = (
      event: Electron.Event<Electron.WebContentsAudioStateChangedEventParams>
    ): void => {
      const browserPageId = this.tabIdByWebContentsId.get(guest.id)
      if (browserPageId) {
        this.notifyAudioStateChanged(browserPageId, event.audible)
      }
    }
    guest.on('audio-state-changed', forwardAudioState)
    const disposeDevToolsWindow = installGuestDevToolsWindowBehavior({
      guest,
      getKeybindings: () => this.settingsResolver?.().keybindings,
      isViewportEmulated: () => {
        const tabId = this.tabIdByWebContentsId.get(guest.id)
        return tabId !== undefined && this.isViewportPresetActive(tabId, guest.id)
      }
    })

    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDetachTracking()
      disposePopupPolicy()
      disposeNavigationPolicy()
      disposeDevToolsWindow()
      if (!guest.isDestroyed()) {
        guest.off('audio-state-changed', forwardAudioState)
      }
    })
  }

  protected notifyAudioStateChanged(browserPageId: string, audible: boolean): void {
    this.resolveRendererForBrowserTab(browserPageId)?.send('browser:audio-state-changed', {
      browserPageId,
      audible
    })
  }

  /** Document guests share teardown without installing browsing navigation or popup policies. */
  protected attachWorkspaceDocGuestPolicies(
    guest: Electron.WebContents,
    host: Electron.WebContents
  ): void {
    const disposeDocPolicy = installDocPreviewGuestPolicy(guest, host)
    const handleDestroyed = (): void => {
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)
    guest.on('will-prevent-unload', allowPageUnload)
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDocPolicy()
      try {
        guest.off('destroyed', handleDestroyed)
        guest.off('will-prevent-unload', allowPageUnload)
      } catch {
        // guest may already be destroyed
      }
    })
  }
}
