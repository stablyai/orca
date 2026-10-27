import {
  BROWSING_GUEST_POLICY,
  type BrowserGuestPolicy,
  type PopupOwnerContext
} from './browser-manager-types'
import { BrowserManagerGuestCleanup } from './browser-manager-guest-cleanup'
import { allowPageUnload } from './browser-guest-unload-policy'
import { installDocPreviewGuestPolicy } from './doc-preview-guest-policy'
import { installGuestDevToolsCloseShortcut } from './browser-guest-devtools-close-shortcut'

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
    const disposeDevToolsCloseShortcut = installGuestDevToolsCloseShortcut({
      guest,
      getKeybindings: () => this.settingsResolver?.().keybindings,
      closeDevTools: () => this.closeGuestDevTools(guest)
    })

    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDetachTracking()
      disposePopupPolicy()
      disposeNavigationPolicy()
      disposeDevToolsCloseShortcut()
      if (!guest.isDestroyed()) {
        guest.off('audio-state-changed', forwardAudioState)
      }
      // A docked host outliving its guest would stay painted over the pane.
      void this.devToolsDock.close(guest.id)
    })
  }

  protected notifyAudioStateChanged(browserPageId: string, audible: boolean): void {
    this.resolveRendererForBrowserTab(browserPageId)?.send('browser:audio-state-changed', {
      browserPageId,
      audible
    })
  }

  /** Closes the page's DevTools wherever they are: docked in the pane or in their own window. */
  protected closeGuestDevTools(guest: Electron.WebContents): void {
    if (this.devToolsDock.isDocked(guest.id)) {
      void this.devToolsDock.close(guest.id)
    } else if (!guest.isDestroyed()) {
      guest.closeDevTools()
    }
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
