/* eslint-disable max-lines -- Why: BrowserManager intentionally remains the
single privileged facade for guest registration, authorization, and lifecycle
cleanup even after extracting the grab/session helpers. Keeping that ownership
in one file avoids scattering the browser security boundary across modules. */
import { randomUUID } from 'node:crypto'

import { shell, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent,
  BrowserPermissionDeniedEvent,
  BrowserPopupEvent
} from '../../shared/browser-guest-events'
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
  browserPageId?: string
  browserTabId?: string
  workspaceId?: string
  webContentsId: number
  rendererWebContentsId: number
}

type PendingPermissionEvent = Omit<BrowserPermissionDeniedEvent, 'browserPageId'>
type PendingPopupEvent = Omit<BrowserPopupEvent, 'browserPageId'>

type ActiveDownload = {
  downloadId: string
  guestWebContentsId: number
  browserTabId: string | null
  rendererWebContentsId: number | null
  origin: string
  filename: string
  totalBytes: number | null
  mimeType: string | null
  item: Electron.DownloadItem
  state: 'requested' | 'downloading'
  savePath: string | null
  pendingCancelTimer: ReturnType<typeof setTimeout> | null
  cleanup: (() => void) | null
}

function safeOrigin(rawUrl: string): string {
  const external = normalizeExternalBrowserUrl(rawUrl)
  const urlToParse = external ?? rawUrl
  try {
    return new URL(urlToParse).origin
  } catch {
    return external ?? 'unknown'
  }
}

class BrowserManager {
  private readonly webContentsIdByTabId = new Map<string, number>()
  // Why: reverse map enables O(1) guest→tab lookups instead of O(N) linear
  // scans on every mouse event, load failure, permission, and popup event.
  private readonly tabIdByWebContentsId = new Map<number, string>()
  private readonly rendererWebContentsIdByTabId = new Map<string, number>()
  private readonly contextMenuCleanupByTabId = new Map<string, () => void>()
  private readonly grabShortcutCleanupByTabId = new Map<string, () => void>()
  private readonly shortcutForwardingCleanupByTabId = new Map<string, () => void>()
  private readonly policyAttachedGuestIds = new Set<number>()
  private readonly policyCleanupByGuestId = new Map<number, () => void>()
  private readonly pendingLoadFailuresByGuestId = new Map<
    number,
    { code: number; description: string; validatedUrl: string }
  >()
  private readonly pendingPermissionEventsByGuestId = new Map<number, PendingPermissionEvent[]>()
  private readonly pendingPopupEventsByGuestId = new Map<number, PendingPopupEvent[]>()
  private readonly pendingDownloadIdsByGuestId = new Map<number, string[]>()
  private readonly downloadsById = new Map<string, ActiveDownload>()
  private readonly grabSessionController = new BrowserGrabSessionController()

  private resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId: number): string | null {
    return this.tabIdByWebContentsId.get(guestWebContentsId) ?? null
  }

  private resolveRendererForBrowserTab(browserTabId: string): Electron.WebContents | null {
    const rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId)
    if (!rendererWebContentsId) {
      return null
    }
    const renderer = webContents.fromId(rendererWebContentsId)
    if (!renderer || renderer.isDestroyed()) {
      return null
    }
    return renderer
  }

  attachGuestPolicies(guest: Electron.WebContents): void {
    if (this.policyAttachedGuestIds.has(guest.id)) {
      return
    }
    this.policyAttachedGuestIds.add(guest.id)
    guest.setBackgroundThrottling(true)
    guest.setWindowOpenHandler(({ url }) => {
      const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guest.id)
      const browserUrl = normalizeBrowserNavigationUrl(url)
      const externalUrl = normalizeExternalBrowserUrl(url)

      // Why: popup-capable guests are required for OAuth and target=_blank
      // flows, but Orca still does not host child windows itself. For normal
      // web URLs, route the request into Orca's own browser-tab model first so
      // the user stays in the IDE. Only fall back to the system browser when
      // Orca cannot safely host the destination or when the guest is not yet
      // associated with a trusted browser tab/renderer.
      if (browserTabId && browserUrl && this.openLinkInOrcaTab(browserTabId, browserUrl)) {
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(browserUrl),
          action: 'opened-in-orca'
        })
      } else if (externalUrl) {
        void shell.openExternal(externalUrl)
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else {
        // Why: popup attempts can carry auth redirects and one-time tokens.
        // Surface only sanitized origin metadata so the renderer can explain
        // the blocked action without persisting sensitive URL details.
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(url),
          action: 'blocked'
        })
      }
      return { action: 'deny' }
    })

    const navigationGuard = (event: Electron.Event, url: string): void => {
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: `will-attach-webview` only validates the initial src. Main must
        // keep enforcing the same allowlist for later guest navigations too.
        event.preventDefault()
      }
    }

    const didFailLoadHandler = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || errorCode === -3) {
        return
      }
      this.forwardOrQueueGuestLoadFailure(guest.id, {
        code: errorCode,
        description: errorDescription || 'This site could not be reached.',
        validatedUrl: validatedURL || guest.getURL() || 'about:blank'
      })
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', navigationGuard)
    guest.on('did-fail-load', didFailLoadHandler)

    // Why: store cleanup so unregisterGuest can remove these listeners when the
    // guest surface is torn down, preventing the callbacks from preventing GC of
    // the underlying WebContents wrapper.
    this.policyCleanupByGuestId.set(guest.id, () => {
      if (!guest.isDestroyed()) {
        guest.off('will-navigate', navigationGuard)
        guest.off('will-redirect', navigationGuard)
        guest.off('did-fail-load', didFailLoadHandler)
      }
    })
  }

  registerGuest({
    browserPageId,
    browserTabId: legacyBrowserTabId,
    webContentsId,
    rendererWebContentsId
  }: BrowserGuestRegistration): void {
    const browserTabId = browserPageId ?? legacyBrowserTabId
    if (!browserTabId) {
      return
    }
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
    this.tabIdByWebContentsId.set(webContentsId, browserTabId)
    this.rendererWebContentsIdByTabId.set(browserTabId, rendererWebContentsId)

    this.setupContextMenu(browserTabId, guest)
    this.setupGrabShortcut(browserTabId, guest)
    this.setupShortcutForwarding(browserTabId, guest)
    this.flushPendingLoadFailure(browserTabId, webContentsId)
    this.flushPendingPermissionEvents(browserTabId, webContentsId)
    this.flushPendingPopupEvents(browserTabId, webContentsId)
    this.flushPendingDownloadRequests(browserTabId, webContentsId)
  }

  unregisterGuest(browserTabId: string): void {
    // Why: unregistering a guest while a grab is active means the guest is
    // being torn down. Cancel the grab so the renderer gets a clean signal
    // instead of a dangling Promise.
    this.cancelGrabOp(browserTabId, 'evicted')

    // Why: remove the policy listeners attached in attachGuestPolicies so the
    // callbacks (which close over the guest WebContents) do not prevent GC of
    // the underlying Chromium surface after the guest is destroyed.
    const guestWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (guestWebContentsId !== undefined) {
      const policyCleanup = this.policyCleanupByGuestId.get(guestWebContentsId)
      if (policyCleanup) {
        policyCleanup()
        this.policyCleanupByGuestId.delete(guestWebContentsId)
      }
      this.policyAttachedGuestIds.delete(guestWebContentsId)
    }

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
    // Why: paused downloads wait for explicit product approval. If the owning
    // browser tab disappears first, cancel the request so the app does not
    // retain orphaned download items or write files after context is gone.
    for (const [downloadId, download] of this.downloadsById.entries()) {
      if (download.browserTabId === browserTabId && download.state === 'requested') {
        this.cancelDownloadInternal(downloadId, 'Tab closed before download was accepted.')
      }
    }
    const wcId = this.webContentsIdByTabId.get(browserTabId)
    if (wcId !== undefined) {
      this.tabIdByWebContentsId.delete(wcId)
    }
    this.webContentsIdByTabId.delete(browserTabId)
    this.rendererWebContentsIdByTabId.delete(browserTabId)
  }

  unregisterAll(): void {
    // Cancel all active grab ops before tearing down registrations
    this.grabSessionController.cancelAll('evicted')
    for (const downloadId of this.downloadsById.keys()) {
      this.cancelDownloadInternal(downloadId, 'Orca is shutting down.')
    }
    for (const browserTabId of this.webContentsIdByTabId.keys()) {
      this.unregisterGuest(browserTabId)
    }
    this.policyAttachedGuestIds.clear()
    // Why: unregisterGuest only cleans up guests that were registered (have an
    // entry in webContentsIdByTabId). Guests that went through
    // attachGuestPolicies but were never registered still have cleanup closures
    // here — invoke them so their event listeners are removed before clearing.
    for (const cleanup of this.policyCleanupByGuestId.values()) {
      cleanup()
    }
    this.policyCleanupByGuestId.clear()
    this.tabIdByWebContentsId.clear()
    this.pendingLoadFailuresByGuestId.clear()
    this.pendingPermissionEventsByGuestId.clear()
    this.pendingPopupEventsByGuestId.clear()
    this.pendingDownloadIdsByGuestId.clear()
  }

  getGuestWebContentsId(browserTabId: string): number | null {
    return this.webContentsIdByTabId.get(browserTabId) ?? null
  }

  notifyPermissionDenied(args: {
    guestWebContentsId: number
    permission: string
    rawUrl: string
  }): void {
    this.forwardOrQueuePermissionDenied(args.guestWebContentsId, {
      permission: args.permission,
      origin: safeOrigin(args.rawUrl)
    })
  }

  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    const { guestWebContentsId, item } = args
    const downloadId = randomUUID()
    const filename = (() => {
      try {
        return item.getFilename() || 'download'
      } catch {
        return 'download'
      }
    })()
    const totalBytes = (() => {
      try {
        const total = item.getTotalBytes()
        return total > 0 ? total : null
      } catch {
        return null
      }
    })()
    const mimeType = (() => {
      try {
        const mime = item.getMimeType()
        return mime || null
      } catch {
        return null
      }
    })()
    const origin = (() => {
      try {
        return safeOrigin(item.getURL())
      } catch {
        return 'unknown'
      }
    })()

    try {
      item.pause()
    } catch {
      // Why: some interrupted downloads throw if paused immediately. Keep
      // tracking the item anyway so Orca can still explain the failure path.
    }

    const download: ActiveDownload = {
      downloadId,
      guestWebContentsId,
      browserTabId: null,
      rendererWebContentsId: null,
      origin,
      filename,
      totalBytes,
      mimeType,
      item,
      state: 'requested',
      savePath: null,
      pendingCancelTimer: null,
      cleanup: null
    }
    this.downloadsById.set(downloadId, download)

    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (browserTabId) {
      this.bindDownloadToTab(downloadId, browserTabId)
      this.sendDownloadRequested(downloadId)
    } else {
      const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId) ?? []
      pending.push(downloadId)
      this.pendingDownloadIdsByGuestId.set(guestWebContentsId, pending)
    }

    // Why: fail closed if the user never explicitly accepts or cancels. This
    // prevents a compromised or crashed renderer from leaving paused downloads
    // alive until app shutdown and later resuming them without context.
    download.pendingCancelTimer = setTimeout(() => {
      this.cancelDownloadInternal(downloadId, 'Timed out waiting for user approval.')
    }, 60_000)
  }

  getDownloadPrompt(downloadId: string, senderWebContentsId: number): { filename: string } | null {
    const download = this.downloadsById.get(downloadId)
    if (!download || download.rendererWebContentsId !== senderWebContentsId) {
      return null
    }
    return { filename: download.filename }
  }

  acceptDownload(args: {
    downloadId: string
    senderWebContentsId: number
    savePath: string
  }): { ok: true } | { ok: false; reason: string } {
    const download = this.downloadsById.get(args.downloadId)
    if (!download || download.rendererWebContentsId !== args.senderWebContentsId) {
      return { ok: false, reason: 'not-authorized' }
    }
    if (download.state !== 'requested' || !download.browserTabId) {
      return { ok: false, reason: 'not-ready' }
    }

    if (download.pendingCancelTimer) {
      clearTimeout(download.pendingCancelTimer)
      download.pendingCancelTimer = null
    }

    try {
      download.item.setSavePath(args.savePath)
      download.savePath = args.savePath
    } catch {
      this.cancelDownloadInternal(args.downloadId, 'Failed to set download destination.')
      return { ok: false, reason: 'not-ready' }
    }

    download.state = 'downloading'
    const cleanup = (): void => {
      try {
        download.item.removeAllListeners('updated')
        download.item.removeAllListeners('done')
      } catch {
        // Why: completed DownloadItems can already be finalized when cleanup
        // runs. Cleanup must stay best-effort so UI teardown never crashes main.
      }
    }
    download.cleanup = cleanup

    download.item.on('updated', (_event, state) => {
      if (state !== 'progressing') {
        return
      }
      this.sendDownloadProgress(download.browserTabId, {
        downloadId: download.downloadId,
        receivedBytes: download.item.getReceivedBytes(),
        totalBytes: download.totalBytes
      })
    })

    download.item.once('done', (_event, state) => {
      const status: BrowserDownloadFinishedEvent['status'] =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'canceled' : 'failed'
      this.sendDownloadFinished(download.browserTabId, {
        downloadId: download.downloadId,
        status,
        savePath: download.savePath,
        error:
          status === 'failed'
            ? state === 'interrupted'
              ? 'Download was interrupted.'
              : 'Download failed.'
            : null
      })
      cleanup()
      this.downloadsById.delete(download.downloadId)
    })

    try {
      download.item.resume()
    } catch {
      this.cancelDownloadInternal(args.downloadId, 'Failed to start download.')
      return { ok: false, reason: 'not-ready' }
    }

    return { ok: true }
  }

  cancelDownload(args: { downloadId: string; senderWebContentsId: number }): boolean {
    const download = this.downloadsById.get(args.downloadId)
    if (!download || download.rendererWebContentsId !== args.senderWebContentsId) {
      return false
    }
    this.cancelDownloadInternal(args.downloadId, 'Canceled.')
    return true
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
      this.tabIdByWebContentsId.delete(webContentsId)
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
      this.tabIdByWebContentsId.delete(guestId)
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
        resolveRenderer: (tabId) => this.resolveRendererForBrowserTab(tabId)
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
    const browserTabId = this.tabIdByWebContentsId.get(guestWebContentsId)
    if (!browserTabId) {
      // Why: some localhost failures happen before the renderer finishes
      // registering which tab owns this guest. Queue the failure by guest ID so
      // registerGuest can replay it instead of silently losing the error state.
      this.pendingLoadFailuresByGuestId.set(guestWebContentsId, loadError)
      return
    }
    this.sendGuestLoadFailure(browserTabId, loadError)
  }

  private forwardOrQueuePermissionDenied(
    guestWebContentsId: number,
    event: PendingPermissionEvent
  ): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPermissionEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPermissionDenied(browserTabId, event)
  }

  private flushPendingPermissionEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPermissionEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPermissionEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPermissionDenied(browserTabId, event)
    }
  }

  private sendPermissionDenied(browserTabId: string, event: PendingPermissionEvent): void {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:permission-denied', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPermissionDeniedEvent)
  }

  private forwardOrQueuePopupEvent(guestWebContentsId: number, event: PendingPopupEvent): void {
    const browserTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (!browserTabId) {
      const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId) ?? []
      pending.push(event)
      if (pending.length > 5) {
        pending.shift()
      }
      this.pendingPopupEventsByGuestId.set(guestWebContentsId, pending)
      return
    }
    this.sendPopupEvent(browserTabId, event)
  }

  private flushPendingPopupEvents(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingPopupEventsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingPopupEventsByGuestId.delete(guestWebContentsId)
    for (const event of pending) {
      this.sendPopupEvent(browserTabId, event)
    }
  }

  private sendPopupEvent(browserTabId: string, event: PendingPopupEvent): void {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:popup', {
      browserPageId: browserTabId,
      ...event
    } satisfies BrowserPopupEvent)
  }

  private bindDownloadToTab(downloadId: string, browserTabId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    download.browserTabId = browserTabId
    download.rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId) ?? null
  }

  private flushPendingDownloadRequests(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    for (const downloadId of pending) {
      this.bindDownloadToTab(downloadId, browserTabId)
      this.sendDownloadRequested(downloadId)
    }
  }

  private sendDownloadRequested(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download?.browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(download.browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-requested', {
      browserPageId: download.browserTabId,
      downloadId: download.downloadId,
      origin: download.origin,
      filename: download.filename,
      totalBytes: download.totalBytes,
      mimeType: download.mimeType
    } satisfies BrowserDownloadRequestedEvent)
  }

  private sendDownloadProgress(
    browserTabId: string | null,
    payload: BrowserDownloadProgressEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-progress', payload)
  }

  private sendDownloadFinished(
    browserTabId: string | null,
    payload: BrowserDownloadFinishedEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-finished', payload)
  }

  private cancelDownloadInternal(downloadId: string, reason: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }

    if (download.pendingCancelTimer) {
      clearTimeout(download.pendingCancelTimer)
      download.pendingCancelTimer = null
    }
    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }

    try {
      download.item.cancel()
    } catch {
      // Why: DownloadItem.cancel can throw after the item has already
      // finalized. Cleanup here is best-effort because the UI state is the
      // source of truth for whether Orca still considers the request active.
    }

    if (download.browserTabId) {
      this.sendDownloadFinished(download.browserTabId, {
        downloadId: download.downloadId,
        status: 'canceled',
        savePath: download.savePath,
        error: reason || null
      })
    }

    this.downloadsById.delete(downloadId)
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
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }

    renderer.send('browser:guest-load-failed', {
      browserPageId: browserTabId,
      loadError
    })
  }

  private openLinkInOrcaTab(browserTabId: string, rawUrl: string): boolean {
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return false
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(rawUrl)
    if (!normalizedUrl || normalizedUrl === 'about:blank') {
      return false
    }
    // Why: the guest context menu knows which browser tab the click came from,
    // but only the renderer owns the worktree/tab model. Forward the validated
    // URL back to that renderer so it can open a sibling Orca browser tab in
    // the same worktree without letting the guest process mutate app state.
    renderer.send('browser:open-link-in-orca-tab', {
      browserPageId: browserTabId,
      url: normalizedUrl
    })
    return true
  }
}

export const browserManager = new BrowserManager()
