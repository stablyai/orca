import { resolveRendererWebContents } from '../browser-guest-renderer-target'
import { setupGuestContextMenu } from '../input/browser-guest-context-menu'
import { setupGrabShortcutForwarding } from '../input/shortcuts/browser-guest-grab-shortcuts'
import { setupGuestMouseWheelZoomForwarding } from '../input/browser-guest-wheel-zoom'
import { setupGuestShortcutForwarding } from '../input/shortcuts/browser-guest-shortcut-forwarding'
import { setupGuestTargetUrlForwarding } from '../input/browser-guest-target-url'
import { BrowserManagerGrab } from './grab/browser-manager-grab'
import {
  isRemoteDesktopGuest,
  setupRemoteDesktopGuest
} from '../../../hosted-sandbox/remote-desktop-guest'

export abstract class BrowserManagerBindings extends BrowserManagerGrab {
  protected setupContextMenu(browserTabId: string, guest: Electron.WebContents): void {
    this.contextMenuCleanupByTabId.set(
      browserTabId,
      setupGuestContextMenu({
        browserTabId,
        guest,
        resolveRenderer: (tabId) => this.resolveRendererForBrowserTab(tabId)
      })
    )
  }

  protected setupGrabShortcut(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }

    this.grabShortcutCleanupByTabId.set(
      browserTabId,
      setupGrabShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        hasActiveGrabOp: (tabId) => this.hasActiveGrabOp(tabId),
        getKeybindings: () => this.settingsResolver?.().keybindings
      })
    )
  }

  protected setupShortcutForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }

    this.shortcutForwardingCleanupByTabId.set(
      browserTabId,
      setupGuestShortcutForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        shouldForwardDictationShortcut: () => this.shouldForwardDictationShortcut?.() ?? false,
        isMobileEmulatorEnabled: () => this.settingsResolver?.().mobileEmulatorEnabled !== false,
        getKeybindings: () => this.settingsResolver?.().keybindings,
        resolveWorktreeId: (tabId) => this.worktreeIdByTabId.get(tabId) ?? null,
        resolveWorkspaceId: (tabId) => this.workspaceIdByPageId.get(tabId) ?? null,
        // A focused remote desktop keeps every key (VM-console style) until its release chord.
        isKeyboardCaptured: () => isRemoteDesktopGuest(guest)
      })
    )
  }

  protected setupMouseWheelZoomForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.mouseWheelZoomCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.mouseWheelZoomCleanupByTabId.delete(browserTabId)
    }

    this.mouseWheelZoomCleanupByTabId.set(
      browserTabId,
      setupGuestMouseWheelZoomForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        isViewportPresetActive: () => this.isViewportPresetActive(browserTabId, guest.id),
        canViewportScroll: (mouse) => this.canViewportScroll(browserTabId, mouse),
        onViewportWheelConsumed: (deltaX, deltaY) =>
          this.recordViewportScrollDelta(browserTabId, deltaX, deltaY)
      })
    )
  }

  protected setupRemoteDesktopGuest(browserTabId: string, guest: Electron.WebContents): void {
    this.remoteDesktopCleanupByTabId.get(browserTabId)?.()
    this.remoteDesktopCleanupByTabId.set(
      browserTabId,
      setupRemoteDesktopGuest({
        browserPageId: browserTabId,
        guest,
        notify: (event) => {
          const renderer = this.resolveRendererForBrowserTab(browserTabId)
          if (!renderer || renderer.isDestroyed()) {
            return
          }
          if (event.kind === 'release') {
            renderer.send('browser:remoteDesktopRelease', { browserPageId: browserTabId })
          } else {
            renderer.send('browser:remoteDesktopState', event.state)
          }
        }
      })
    )
  }

  protected setupTargetUrlForwarding(browserTabId: string, guest: Electron.WebContents): void {
    this.targetUrlCleanupByTabId.get(browserTabId)?.()
    this.targetUrlCleanupByTabId.set(
      browserTabId,
      setupGuestTargetUrlForwarding({
        browserTabId,
        guest,
        resolveRenderer: (tabId) => this.resolveRendererForBrowserTab(tabId)
      })
    )
  }
}
