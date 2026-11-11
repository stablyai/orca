import { BROWSING_GUEST_POLICY } from './browser-guest-policy-profile'
import { webContents } from 'electron'
import type { BrowserGuestPolicy } from './browser-guest-policy-profile'
import type { PopupOwnerContext } from '../../popups/browser-popup-ownership'
import { BrowserManagerGuestCleanup } from './browser-manager-guest-cleanup'
import { allowPageUnload } from '../../navigation/browser-guest-unload-policy'
import {
  installDocPreviewGuestPolicy,
  readDocPreviewGuestBoundPageId,
  getWorkspaceDocPageGuest
} from '../../../document-preview/doc-preview-guest-policy'
import { setupGuestEscapeForwarding } from '../../input/shortcuts/browser-guest-escape-forwarding'
import { setupGuestShortcutForwarding } from '../../input/shortcuts/browser-guest-shortcut-forwarding'
import { forwardGuestMousePress } from '../../input/browser-guest-mouse-press'
import { installGuestDevToolsCloseShortcut } from '../../devtools/browser-guest-devtools-close-shortcut'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection
} from './browser-guest-discard-protection'
import { readBrowserMemoryPageDiscardProtection } from '../../browser-page-memory'

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
    const disposePopupPolicy = this.installGuestPopupPolicy(guest)
    const disposeNavigationPolicy = this.installGuestNavigationPolicy(guest)
    const disposeDiscardProtection = installBrowserGuestDiscardProtection(guest, () =>
      this.invalidateGuestMemoryProtection(guest)
    )
    const invalidate = (): void => this.invalidateGuestMemoryProtection(guest)
    const inPageNavigation = (_event: Electron.Event, _url: string, mainFrame: boolean): void => {
      if (mainFrame) {
        invalidate()
      }
    }
    guest.on('did-stop-loading', invalidate)
    guest.on('did-navigate', invalidate)
    guest.on('did-navigate-in-page', inPageNavigation)
    guest.on('devtools-closed', invalidate)
    guest.on('devtools-opened', invalidate)
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
    const disposeEscapeForwarding = setupGuestEscapeForwarding({
      guest,
      resolveTarget: () => {
        const browserPageId = this.tabIdByWebContentsId.get(guest.id)
        const renderer = browserPageId ? this.resolveRendererForBrowserTab(browserPageId) : null
        return browserPageId && renderer ? { browserPageId, renderer } : null
      },
      hasActiveGrabOp: (browserPageId) => this.hasActiveGrabOp(browserPageId)
    })

    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDetachTracking()
      disposePopupPolicy()
      disposeNavigationPolicy()
      disposeDiscardProtection()
      guest.off('did-stop-loading', invalidate)
      guest.off('did-navigate', invalidate)
      guest.off('did-navigate-in-page', inPageNavigation)
      guest.off('devtools-closed', invalidate)
      guest.off('devtools-opened', invalidate)
      disposeDevToolsCloseShortcut()
      disposeEscapeForwarding()
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

  protected notifyGuestDiscardProtection(browserPageId: string, guest: Electron.WebContents): void {
    if (this.webContentsIdByTabId.get(browserPageId) !== guest.id) {
      return
    }
    try {
      this.resolveRendererForBrowserTab(browserPageId)?.send(
        'browser:guest-discard-protection-changed',
        {
          browserPageId,
          ...this.readGuestDiscardProtection(browserPageId, guest)
        }
      )
    } catch {
      // A disposed renderer must not fail a lifecycle terminal.
    }
  }

  readGuestDiscardProtection(
    browserPageId: string,
    guest: Electron.WebContents
  ): ReturnType<typeof readBrowserMemoryPageDiscardProtection> {
    return readBrowserMemoryPageDiscardProtection(
      browserPageId,
      guest,
      this.rendererWebContentsIdByTabId.get(browserPageId)
    )
  }

  invalidateGuestMemoryProtection(guest: Electron.WebContents): void {
    const pageId = this.tabIdByWebContentsId.get(guest.id)
    if (pageId && !guest.isDestroyed() && webContents.fromId(guest.id) === guest) {
      this.notifyGuestDiscardProtection(pageId, guest)
    }
  }

  /** Closes the page's DevTools wherever they are: docked in the pane or in their own window. */
  protected closeGuestDevTools(guest: Electron.WebContents): void {
    const docked = this.devToolsDock.isDocked(guest.id)
    void this.devToolsDock.close(guest.id)
    if (!docked && !guest.isDestroyed()) {
      guest.closeDevTools()
    }
  }

  /** Document guests share teardown without installing browsing navigation or popup policies. */
  protected attachWorkspaceDocGuestPolicies(
    guest: Electron.WebContents,
    host: Electron.WebContents
  ): void {
    const disposeDocPolicy = installDocPreviewGuestPolicy(guest, host)
    const publishProtection = (): void => {
      const pageId = readDocPreviewGuestBoundPageId(guest)
      if (!pageId || host.isDestroyed() || getWorkspaceDocPageGuest(pageId, host.id) !== guest) {
        return
      }
      host.send('browser:guest-discard-protection-changed', {
        browserPageId: pageId,
        ...readBrowserGuestDiscardProtection(guest)
      })
    }
    const disposeDiscardProtection = installBrowserGuestDiscardProtection(guest, publishProtection)
    publishProtection()
    const resolveHost = (): Electron.WebContents | null => (host.isDestroyed() ? null : host)
    const disposeEscapeForwarding = setupGuestEscapeForwarding({
      guest,
      resolveTarget: () => {
        const browserPageId = readDocPreviewGuestBoundPageId(guest)
        return browserPageId ? { browserPageId, renderer: host } : null
      },
      hasActiveGrabOp: (browserPageId) => this.hasActiveGrabOp(browserPageId)
    })
    // Why: a focused preview swallows keys, so Orca's window shortcuts (Ctrl+Tab, close tab) are
    // forwarded to its own host as for plugin frames; browser-page chords stay with the document.
    const disposeShortcutForwarding = setupGuestShortcutForwarding({
      browserTabId: `workspace-doc:${guest.id}`,
      guest,
      resolveRenderer: resolveHost,
      getKeybindings: () => this.settingsResolver?.().keybindings,
      browserPage: false
    })
    // Why: a press in the preview never reaches the host DOM, so its split stays inactive and
    // forwarded shortcuts like Close would act on another split (#22144). Presses only: previews
    // have no history listener for the side buttons a release would send.
    const reportPress = (_event: Electron.Event, mouse: Electron.MouseInputEvent): void => {
      if (mouse.type !== 'mouseDown') {
        return
      }
      const browserPageId = readDocPreviewGuestBoundPageId(guest)
      if (browserPageId) {
        forwardGuestMousePress(guest, browserPageId, resolveHost, mouse)
      }
    }
    guest.on('before-mouse-event', reportPress)
    const handleDestroyed = (): void => {
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)
    guest.on('will-prevent-unload', allowPageUnload)
    this.policyCleanupByGuestId.set(guest.id, () => {
      disposeDocPolicy()
      disposeDiscardProtection()
      disposeEscapeForwarding()
      disposeShortcutForwarding()
      try {
        guest.off('destroyed', handleDestroyed)
        guest.off('will-prevent-unload', allowPageUnload)
        guest.off('before-mouse-event', reportPress)
      } catch {
        // guest may already be destroyed
      }
    })
  }
}
