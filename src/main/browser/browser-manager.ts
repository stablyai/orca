/* eslint-disable max-lines -- Why: BrowserManager intentionally remains the
single privileged facade for guest registration, authorization, and lifecycle
cleanup even after extracting the grab/session helpers. Keeping that ownership
in one file avoids scattering the browser security boundary across modules. */
import { shell, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import type {
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot
} from '../../shared/browser-grab-types'
import { buildGuestOverlayScript } from './grab-guest-script'
import { clampGrabPayload } from './browser-grab-payload'
import { captureSelectionScreenshot as captureGrabSelectionScreenshot } from './browser-grab-screenshot'
import { BrowserGrabSessionController } from './browser-grab-session-controller'
import {
  resolveRendererWebContents,
  setupGrabShortcutForwarding,
  setupGuestContextMenu,
  setupGuestShortcutForwarding
} from './browser-guest-ui'

export type BrowserGuestRegistration = {
  browserTabId: string
  webContentsId: number
  rendererWebContentsId: number
}

class BrowserManager {
  private readonly webContentsIdByTabId = new Map<string, number>()
  private readonly rendererWebContentsIdByTabId = new Map<string, number>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  private readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  private readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  private readonly policyAttachedGuestIds = new Set<number>()
  private readonly pendingLoadFailuresByGuestId = new Map<
    number,
    { code: number; description: string; validatedUrl: string }
  >()
  private readonly grabSessionController = new BrowserGrabSessionController()

  private openValidatedExternal(rawUrl: string): void {
    const externalUrl = normalizeExternalBrowserUrl(rawUrl)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
  }

  attachGuestPolicies(guest: Electron.WebContents): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    guest.setBackgroundThrottling(true)
    guest.setWindowOpenHandler(({ url }) => {
      // Why: popup-capable guests are required for OAuth and target=_blank
      // flows, but Orca still does not host child windows itself. Convert those
      // attempts into a controlled external-open path instead of letting them
      // silently fail or spawn unmanaged windows.
      this.openValidatedExternal(url)
      return { action: 'deny' }
    })

    const navigationGuard = (event: Electron.Event, url: string): void => {
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: `will-attach-webview` only validates the initial src. Main must
        // keep enforcing the same allowlist for later guest navigations too.
        event.preventDefault()
      }
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', navigationGuard)
    guest.on(
      'did-fail-load',
      (
        _event: Electron.Event,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean
      ) => {
        if (!isMainFrame || errorCode === -3) {
          return
        }
        this.forwardOrQueueGuestLoadFailure(guest.id, {
          code: errorCode,
          description: errorDescription || 'This site could not be reached.',
          validatedUrl: validatedURL || guest.getURL() || 'about:blank'
        })
      }
    )
  }

  registerGuest({
    browserTabId,
    webContentsId,
    rendererWebContentsId
  }: BrowserGuestRegistration): void {
    // Why: re-registering the same browser tab can happen when Chromium swaps
    // or recreates the underlying guest surface. Any active grab is bound to
    // the old guest's listeners and teardown path, so keeping it alive would
    // leave the session attached to a stale webContents until timeout.
    this.cancelGrabOp(browserTabId, 'evicted')

    const previousCleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (previousCleanup) {
      previousCleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }

    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return
    }

    // Why: the renderer sends webContentsId, which we must not blindly trust.
    // A compromised renderer could send the main window's own webContentsId,
    // causing us to overwrite its setWindowOpenHandler or attach unintended
    // context menus. Only accept genuine webview guest surfaces.
    if (guest.getType() !== 'webview') {
      return
    }
    if (!this.policyAttachedGuestIds.has(webContentsId)) {
      // Why: renderer registration is only the second half of the guest setup.
      // Main must only trust guests that already passed attach-time policy
      // installation; otherwise a trusted renderer could point us at some other
      // arbitrary webview and bypass the intended host-window attach boundary.
      return
    }

    this.webContentsIdByTabId.set(browserTabId, webContentsId)
    this.rendererWebContentsIdByTabId.set(browserTabId, rendererWebContentsId)

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.flushPendingLoadFailure(browserTabId, webContentsId)
  }

  unregisterGuest(browserTabId: string): void {
    // Why: unregistering a guest while a grab is active means the guest is
    // being torn down. Cancel the grab so the renderer gets a clean signal
    // instead of a dangling Promise.
    this.cancelGrabOp(browserTabId, 'evicted')

    const cleanup = this.contextMenuCleanupByTabId.get(browserTabId)
    if (cleanup) {
      cleanup()
      this.contextMenuCleanupByTabId.delete(browserTabId)
    }
    const shortcutCleanup = this.grabShortcutCleanupByTabId.get(browserTabId)
    if (shortcutCleanup) {
      shortcutCleanup()
      this.grabShortcutCleanupByTabId.delete(browserTabId)
    }
    const fwdCleanup = this.shortcutForwardingCleanupByTabId.get(browserTabId)
    if (fwdCleanup) {
      fwdCleanup()
      this.shortcutForwardingCleanupByTabId.delete(browserTabId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
    this.rendererWebContentsIdByTabId.delete(browserTabId)
  }

  unregisterAll(): void {
    // Cancel all active grab ops before tearing down registrations
    this.grabSessionController.cancelAll('evicted')
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
    this.pendingLoadFailuresByGuestId.clear()
  }

  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  // Why: guest browser surfaces are intentionally isolated from Orca's preload
  // bridge, so renderer code cannot directly call Electron WebContents APIs on
  // them. Main owns the devtools escape hatch and only after tab→guest lookup.
  async openDevTools(browserTabId: string): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.webContentsIdByTabId.delete(browserTabId)
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  // ---------------------------------------------------------------------------
  // Browser Context Grab — main-owned operations
  // ---------------------------------------------------------------------------

  /**
   * Validates that a caller (identified by sender webContentsId) owns the
   * given browserTabId. Returns the guest WebContents or null.
   */
  getAuthorizedGuest(
    browserTabId: string,
    senderWebContentsId: number
  ): Electron.WebContents | null {
    const registeredRenderer = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (registeredRenderer == null || registeredRenderer !== senderWebContentsId) {
      return null
    }
    const guestId = this.webContentsIdByTabId.get(browserTabId)
    if (guestId == null) {
      return null
    }
    const guest = webContents.fromId(guestId)
    if (!guest || guest.isDestroyed()) {
      this.webContentsIdByTabId.delete(browserTabId)
      return null
    }
    return guest
  }

  /** Returns true if a grab operation is currently active for this tab. */
  hasActiveGrabOp(browserTabId: string): boolean {
    return this.grabSessionController.hasActiveGrabOp(browserTabId)
  }

  /**
   * Enable or disable grab mode for a browser tab. When enabled, injects the
   * overlay runtime into the guest. When disabled, cancels any active grab op.
   */
  async setGrabMode(
    browserTabId: string,
    enabled: boolean,
    guest: Electron.WebContents
  ): Promise<boolean> {
    if (!enabled) {
      this.cancelGrabOp(browserTabId, 'user')
      return true
    }
    // Why: injecting the overlay runtime eagerly on arm lets the hover UI
    // appear instantly when the user starts moving the pointer, rather than
    // adding a visible delay between "click Grab" and "overlay appears".
    // The runtime is idempotent — re-injection on the same page is safe.
    try {
      await guest.executeJavaScript(buildGuestOverlayScript('arm'))
      return true
    } catch {
      return false
    }
  }

  /**
   * Await a single grab selection on the given tab. Returns a Promise that
   * resolves exactly once when the user clicks, cancels, or an error occurs.
   *
   * Why the click is handled in-guest rather than via main-side interception:
   * Electron's `before-input-event` only fires for keyboard events, not mouse
   * events on guest webContents. The design doc anticipated a main-owned
   * interceptor, but the spike showed this API gap. The fallback (documented
   * in the design doc) is to let the guest overlay's full-viewport hit-catcher
   * consume the click. The overlay calls `stopPropagation()` and
   * `preventDefault()` so the page underneath does not receive the event.
   * This is not a perfect guarantee (capture-phase listeners on window may
   * still fire), but it covers the vast majority of sites.
   */
  awaitGrabSelection(
    browserTabId: string,
    opId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabResult> {
    return this.grabSessionController.awaitGrabSelection(browserTabId, opId, guest)
  }

  /**
   * Cancel an active grab operation for the given tab.
   */
  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    this.grabSessionController.cancelGrabOp(browserTabId, reason)
  }

  /**
   * Capture a screenshot of the guest surface and optionally crop it to
   * the given CSS-pixel rect.
   */
  async captureSelectionScreenshot(
    _browserTabId: string,
    rect: BrowserGrabRect,
    guest: Electron.WebContents
  ): Promise<BrowserGrabScreenshot | null> {
    return captureGrabSelectionScreenshot(rect, guest)
  }

  /**
   * Extract the payload for the currently hovered element without disrupting
   * the active grab overlay or awaitClick listener. Used by keyboard shortcuts
   * that let the user copy content while hovering, before clicking.
   */
  async extractHoverPayload(
    _browserTabId: string,
    guest: Electron.WebContents
  ): Promise<BrowserGrabPayload | null> {
    try {
      const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('extractHover'))
      if (!rawPayload || typeof rawPayload !== 'object') {
        return null
      }
      return clampGrabPayload(rawPayload)
    } catch {
      return null
    }
  }

  private setupContextMenu(browserTabId: string, guest: Electron.WebContents): void {
    this.contextMenuCleanupByTabId.set(
      browserTabId,
      setupGuestContextMenu({
        browserTabId,
        guest,
        openValidatedExternal: (rawUrl) => {
          this.openValidatedExternal(rawUrl)
        },
        openDevTools: async (tabId) => this.openDevTools(tabId)
      })
    )
  }

  // Why: browser grab mode intentionally uses Cmd/Ctrl+C as its entry
  // gesture, but a focused webview guest is a separate Chromium process so
  // the renderer's window-level keydown handler never sees that shortcut.
  // Only forward the chord when Chromium would not perform a normal copy:
  // no editable element is focused and there is no selected text. That keeps
  // native page copy working while still making the grab shortcut reachable
  // from focused web content.
  private setupGrabShortcut(browserTabId: string, guest: Electron.WebContents): void {
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
        hasActiveGrabOp: (tabId) => this.hasActiveGrabOp(tabId)
      })
    )
  }

  // Why: a focused webview guest is a separate Chromium process — keyboard
  // events go to the guest's own webContents and never fire the renderer's
  // window-level keydown handler or the main window's before-input-event.
  // Intercept common app shortcuts on the guest and forward them to the
  // renderer so they work consistently regardless of which surface has focus.
  private setupShortcutForwarding(browserTabId: string, guest: Electron.WebContents): void {
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
          resolveRendererWebContents(this.rendererWebContentsIdByTabId, tabId)
      })
    )
  }

  private forwardOrQueueGuestLoadFailure(
    guestWebContentsId: number,
    loadError: { code: number; description: string; validatedUrl: string }
  ): void {
    const browserTabId = [...this.webContentsIdByTabId.entries()].find(
      ([, webContentsId]) => webContentsId === guestWebContentsId
    )?.[0]
    if (!browserTabId) {
      // Why: some localhost failures happen before the renderer finishes
      // registering which tab owns this guest. Queue the failure by guest ID so
      // registerGuest can replay it instead of silently losing the error state.
      this.pendingLoadFailuresByGuestId.set(guestWebContentsId, loadError)
      return
    }
    this.sendGuestLoadFailure(browserTabId, loadError)
  }

  private flushPendingLoadFailure(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingLoadFailuresByGuestId.get(guestWebContentsId)
    if (!pending) {
      return
    }
    this.pendingLoadFailuresByGuestId.delete(guestWebContentsId)
    this.sendGuestLoadFailure(browserTabId, pending)
  }

  private sendGuestLoadFailure(
    browserTabId: string,
    loadError: { code: number; description: string; validatedUrl: string }
  ): void {
    const rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (!rendererWebContentsId) {
      return
    }

    const renderer = webContents.fromId(rendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return
    }

    renderer.send('browser:guest-load-failed', {
      browserTabId,
      loadError
    })
  }
}

export const browserManager = new BrowserManager()
