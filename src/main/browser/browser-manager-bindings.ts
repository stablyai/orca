import { resolveRendererWebContents } from './browser-guest-renderer-target'
import { setupGuestContextMenu } from './browser-guest-context-menu'
import {
  handleGrabShortcutInput,
  setupGrabShortcutForwarding
} from './browser-guest-grab-shortcuts'
import {
  forwardGuestViewportWheel,
  setupGuestMouseWheelZoomForwarding
} from './browser-guest-wheel-zoom'
import {
  createGuestShortcutForwardContext,
  setupGuestShortcutForwarding,
  type GuestShortcutForwardingArgs
} from './browser-guest-shortcut-forwarding'
import { setOffscreenPageShortcutContext } from './offscreen-page-keyboard-routing'
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

  /**
   * The grab gesture for a key typed into an offscreen page, whose keys never pass through the
   * guest's before-input-event. Returns true when the key is Orca's and must not reach the page.
   */
  handleOffscreenPageGrabKey(
    browserTabId: string,
    guest: Electron.WebContents,
    input: Pick<
      Electron.Input,
      'type' | 'key' | 'code' | 'meta' | 'control' | 'alt' | 'shift' | 'isAutoRepeat'
    >
  ): boolean {
    return handleGrabShortcutInput(
      {
        browserTabId,
        guest,
        resolveRenderer: (tabId) =>
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
        hasActiveGrabOp: (tabId) => this.hasActiveGrabOp(tabId),
        getKeybindings: () => this.settingsResolver?.().keybindings
      },
      input
    )
  }

  /** Viewport-preset panning for an offscreen page's wheel, which before-mouse-event never sees. */
  handleOffscreenPageViewportWheel(
    browserTabId: string,
    guest: Electron.WebContents,
    wheel: Electron.MouseWheelInputEvent
  ): boolean {
    return forwardGuestViewportWheel(this.viewportWheelArgs(browserTabId, guest), wheel)
  }

  private viewportWheelArgs(browserTabId: string, guest: Electron.WebContents) {
    return {
      browserTabId,
      resolveRenderer: (tabId: string) =>
        resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
      isViewportPresetActive: () => {
        const state = this.viewportPresetByTabId.get(browserTabId)
        return state?.guestWebContentsId === guest.id && state.requested !== null
      },
      canViewportScroll: (mouse: Electron.MouseWheelInputEvent) =>
        this.canViewportScroll(browserTabId, mouse),
      onViewportWheelConsumed: (deltaX: number, deltaY: number) =>
        this.recordViewportScrollDelta(browserTabId, deltaX, deltaY)
    }
  }

  // Why: a focused webview guest is a separate process, so its key events never reach the renderer; intercept and forward app shortcuts.
  // An offscreen page's keys reach the Orca window instead, whose key routing consults the same context.
  protected setupShortcutForwarding(
    browserTabId: string,
    guest: Electron.WebContents,
    isOffscreen = false
  ): void {
    const previousCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }

    const args = this.shortcutForwardingArgs(browserTabId)
    if (isOffscreen) {
      setOffscreenPageShortcutContext(browserTabId, createGuestShortcutForwardContext(args))
      this.shortcutForwardingCleanupByTabId.set(browserTabId, () =>
        setOffscreenPageShortcutContext(browserTabId, null)
      )
      return
    }
    this.shortcutForwardingCleanupByTabId.set(
      browserTabId,
      setupGuestShortcutForwarding({ ...args, guest })
    )
  }

  private shortcutForwardingArgs(browserTabId: string): GuestShortcutForwardingArgs {
    return {
      browserTabId,
      resolveRenderer: (tabId) =>
        resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId),
      shouldForwardDictationShortcut: () => this.shouldForwardDictationShortcut?.() ?? false,
      isMobileEmulatorEnabled: () => this.settingsResolver?.().mobileEmulatorEnabled !== false,
      getKeybindings: () => this.settingsResolver?.().keybindings,
      resolveWorktreeId: (tabId) => this.worktreeIdByTabId.get(tabId) ?? null,
      resolveWorkspaceId: (tabId) => this.workspaceIdByPageId.get(tabId) ?? null
    }
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
        guest,
        ...this.viewportWheelArgs(browserTabId, guest)
      })
    )
  }
}
