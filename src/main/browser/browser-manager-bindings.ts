import { resolveRendererWebContents } from './browser-guest-renderer-target'
import { setupGuestContextMenu } from './browser-guest-context-menu'
import { setupGrabShortcutForwarding } from './browser-guest-grab-shortcuts'
import { setupGuestMouseHistoryForwarding } from './browser-guest-mouse-history'
import { setupGuestMouseWheelZoomForwarding } from './browser-guest-wheel-zoom'
import { setupGuestShortcutForwarding } from './browser-guest-shortcut-forwarding'
import { BrowserManagerGrab } from './browser-manager-grab'

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

  // Why: forward grab's Cmd/Ctrl+C from a focused guest only when no edit field/selection is active, so native copy still works.
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

  // Why: a focused webview guest is a separate process, so its key events never reach the renderer; intercept and forward app shortcuts.
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
        resolveWorkspaceId: (tabId) => this.workspaceIdByPageId.get(tabId) ?? null
      })
    )
  }

  protected setupGuestMouseForwarding(browserTabId: string, guest: Electron.WebContents): void {
    const previousCleanup = this.guestMouseCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.guestMouseCleanupByTabId.delete(browserTabId)
    }

    const resolveRenderer = (tabId: string): Electron.WebContents | null =>
      resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId)
    // Why history first: wheel stays the most recently added before-mouse-event listener.
    const historyCleanup = setupGuestMouseHistoryForwarding({
      browserTabId,
      guest,
      resolveRenderer
    })
    const wheelCleanup = setupGuestMouseWheelZoomForwarding({
      browserTabId,
      guest,
      resolveRenderer,
      isViewportPresetActive: () => {
        const state = this.viewportPresetByTabId.get(browserTabId)
        return state?.guestWebContentsId === guest.id && state.requested !== null
      },
      canViewportScroll: (mouse) => this.canViewportScroll(browserTabId, mouse),
      onViewportWheelConsumed: (deltaX, deltaY) =>
        this.recordViewportScrollDelta(browserTabId, deltaX, deltaY)
    })
    this.guestMouseCleanupByTabId.set(browserTabId, () => {
      wheelCleanup()
      historyCleanup()
    })
  }
}
