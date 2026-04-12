/* eslint-disable max-lines -- Why: BrowserManager is the single owner of guest
lifecycle, context menus, and grab operations. Splitting these into separate
modules would scatter the guest authorization and tab-lookup logic that must
stay consistent when new privileged operations are added. */
import { clipboard, Menu, shell, webContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../shared/browser-url'
import {
  isWindowShortcutModifierChord,
  resolveWindowShortcutAction
} from '../../shared/window-shortcut-policy'
import type {
  BrowserGrabCancelReason,
  BrowserGrabPayload,
  BrowserGrabRect,
  BrowserGrabResult,
  BrowserGrabScreenshot
} from '../../shared/browser-grab-types'
import {
  GRAB_BUDGET,
  GRAB_SAFE_ATTRIBUTE_NAMES,
  GRAB_SECRET_PATTERNS
} from '../../shared/browser-grab-types'
import { buildGuestOverlayScript } from './grab-guest-script'

export type BrowserGuestRegistration = {
  browserTabId: string
  webContentsId: number
  rendererWebContentsId: number
}

/** Tracks the lifecycle of a single grab operation on one browser tab. */
type ActiveGrabOp = {
  opId: string
  browserTabId: string
  guestWebContentsId: number
  resolve: (result: BrowserGrabResult) => void
  /** Cleanup listeners and optionally inject teardown.
   *  @param preserveOverlay When true, skip teardown injection so the guest
   *  overlay stays visible (used when a selection succeeds and the copy menu
   *  is shown). */
  cleanup: (preserveOverlay?: boolean) => void
  /** When true, cleanup skips the teardown injection. Set by awaitGrabSelection
   *  when replacing an existing op so the freshly-armed overlay is preserved. */
  skipTeardown?: boolean
}

/** Hard timeout for an armed grab operation to prevent indefinite hangs. */
const GRAB_OP_TIMEOUT_MS = 120_000

/**
 * Re-validate and clamp all string, array, and budget fields in a grab payload
 * before forwarding to the renderer. This is the main-side safety net: even if
 * the guest runtime is compromised, the payload that reaches renderer chrome
 * respects the documented budgets.
 *
 * Returns null if the payload is structurally invalid (missing required fields).
 */
function clampGrabPayload(raw: unknown): BrowserGrabPayload | null {
  // Why: the guest payload is completely untrusted. A compromised or
  // malfunctioning guest could return anything. Validate structural shape
  // before accessing nested properties to avoid unhandled TypeErrors.
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  if (!obj.page || typeof obj.page !== 'object') {
    return null
  }
  if (!obj.target || typeof obj.target !== 'object') {
    return null
  }

  const page = obj.page as Record<string, unknown>
  const target = obj.target as Record<string, unknown>

  const clampStr = (s: unknown, max: number): string => {
    const str = typeof s === 'string' ? s : ''
    if (str.length <= max) {
      return str
    }
    return `${str.slice(0, max)} (truncated)`
  }

  const clampArray = (arr: unknown, maxEntries: number, maxEntryLength: number): string[] => {
    const items = Array.isArray(arr) ? arr : []
    return items.slice(0, maxEntries).map((item) => clampStr(item, maxEntryLength))
  }

  const safeStr = (s: unknown, max = 500): string => clampStr(s, max)

  const safeNum = (n: unknown, fallback = 0): number =>
    typeof n === 'number' && Number.isFinite(n) ? n : fallback

  // Why: mirror the guest-side secret detection on the main side so a
  // compromised guest cannot smuggle secret-bearing values through attributes
  // or URLs. This is the defense-in-depth layer.
  const containsSecret = (val: string): boolean => {
    const lower = val.toLowerCase()
    return GRAB_SECRET_PATTERNS.some((p) => lower.includes(p))
  }

  // Why: mirror the guest-side URL sanitization. Strip query strings and
  // fragments to prevent token leakage even if the guest is compromised.
  const sanitizeUrl = (raw: unknown): string => {
    const str = typeof raw === 'string' ? raw : ''
    if (!str) {
      return ''
    }
    try {
      const u = new URL(str)
      u.search = ''
      u.hash = ''
      return u.toString()
    } catch {
      // Why: returning the raw string on parse failure could preserve
      // javascript: URIs or other non-http schemes. Return empty.
      return ''
    }
  }

  // Why: re-filter attributes on the main side so a compromised guest cannot
  // smuggle unsafe attribute names (e.g., event handlers) or secret-bearing
  // values into the payload that reaches the renderer.
  const safeAttributes = (attrs: unknown): Record<string, string> => {
    if (!attrs || typeof attrs !== 'object') {
      return {}
    }
    const filtered: Record<string, string> = {}
    for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
      const name = key.toLowerCase()
      const isAria = name.startsWith('aria-')
      const isSafe = GRAB_SAFE_ATTRIBUTE_NAMES.has(name)
      if (!isAria && !isSafe) {
        continue
      }
      const strValue = safeStr(value, 2000)
      if (containsSecret(strValue)) {
        filtered[name] = '[redacted]'
      } else if ((name === 'href' || name === 'src' || name === 'action') && strValue) {
        filtered[name] = sanitizeUrl(strValue)
      } else if (name === 'class') {
        filtered[name] = safeStr(value, 200)
      } else {
        filtered[name] = safeStr(value, 500)
      }
    }
    return filtered
  }

  const safeRect = (r: unknown): BrowserGrabRect => {
    if (!r || typeof r !== 'object') {
      return { x: 0, y: 0, width: 0, height: 0 }
    }
    const rect = r as Record<string, unknown>
    return {
      x: safeNum(rect.x),
      y: safeNum(rect.y),
      width: safeNum(rect.width),
      height: safeNum(rect.height)
    }
  }

  const accessibility = target.accessibility as Record<string, unknown> | null | undefined
  const computedStyles = target.computedStyles as Record<string, unknown> | null | undefined

  return {
    page: {
      // Why: re-sanitize the URL main-side so a compromised guest cannot
      // pass through query strings containing tokens or secrets.
      sanitizedUrl: sanitizeUrl(page.sanitizedUrl),
      title: safeStr(page.title, 500),
      viewportWidth: safeNum(page.viewportWidth),
      viewportHeight: safeNum(page.viewportHeight),
      scrollX: safeNum(page.scrollX),
      scrollY: safeNum(page.scrollY),
      devicePixelRatio: safeNum(page.devicePixelRatio, 1),
      capturedAt: safeStr(page.capturedAt, 100)
    },
    target: {
      tagName: safeStr(target.tagName, 50),
      selector: safeStr(target.selector, 500),
      textSnippet: clampStr(target.textSnippet, GRAB_BUDGET.textSnippetMaxLength),
      htmlSnippet: clampStr(target.htmlSnippet, GRAB_BUDGET.htmlSnippetMaxLength),
      attributes: safeAttributes(target.attributes),
      accessibility: {
        role: safeStr(accessibility?.role) || null,
        accessibleName: safeStr(accessibility?.accessibleName) || null,
        ariaLabel: safeStr(accessibility?.ariaLabel) || null,
        ariaLabelledBy: safeStr(accessibility?.ariaLabelledBy) || null
      },
      rectViewport: safeRect(target.rectViewport),
      rectPage: safeRect(target.rectPage),
      computedStyles: {
        display: safeStr(computedStyles?.display),
        position: safeStr(computedStyles?.position),
        width: safeStr(computedStyles?.width),
        height: safeStr(computedStyles?.height),
        margin: safeStr(computedStyles?.margin),
        padding: safeStr(computedStyles?.padding),
        color: safeStr(computedStyles?.color),
        backgroundColor: safeStr(computedStyles?.backgroundColor),
        border: safeStr(computedStyles?.border),
        borderRadius: safeStr(computedStyles?.borderRadius),
        fontFamily: safeStr(computedStyles?.fontFamily),
        fontSize: safeStr(computedStyles?.fontSize),
        fontWeight: safeStr(computedStyles?.fontWeight),
        lineHeight: safeStr(computedStyles?.lineHeight),
        textAlign: safeStr(computedStyles?.textAlign),
        zIndex: safeStr(computedStyles?.zIndex)
      }
    },
    nearbyText: clampArray(
      obj.nearbyText,
      GRAB_BUDGET.nearbyTextMaxEntries,
      GRAB_BUDGET.nearbyTextEntryMaxLength
    ),
    ancestorPath: clampArray(obj.ancestorPath, GRAB_BUDGET.ancestorPathMaxEntries, 200),
    screenshot: null
  }
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
  private readonly activeGrabOps = new Map<string, ActiveGrabOp>()

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
    for (const browserTabId of this.activeGrabOps.keys()) {
      this.cancelGrabOp(browserTabId, 'evicted')
    }
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
    return this.activeGrabOps.has(browserTabId)
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
    // Why: only one active grab operation per tab prevents race conditions
    // where a late click from a previous operation resolves the wrong Promise.
    const existing = this.activeGrabOps.get(browserTabId)
    if (existing) {
      // Why: skip teardown injection when replacing an op. The new op will
      // reuse the already-armed overlay. If we injected teardown here, it
      // would race with the new awaitClick script in the guest's JS queue
      // and destroy the overlay before the click handler is installed.
      existing.skipTeardown = true
      existing.resolve({ opId: existing.opId, kind: 'cancelled', reason: 'user' })
    }

    return new Promise<BrowserGrabResult>((resolve) => {
      const guestWebContentsId = guest.id
      let settled = false

      const settleOnce = (result: BrowserGrabResult): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeoutId)
        // Why: when the user successfully selects an element, keep the guest
        // overlay visible so the highlight box persists while the renderer
        // shows the copy menu. Teardown happens later when the renderer calls
        // setGrabMode(false) or re-arms with a fresh armAndAwait cycle.
        op.cleanup(result.kind === 'selected' || result.kind === 'context-selected')
        this.activeGrabOps.delete(browserTabId)
        resolve(result)
      }

      // Why: the guest overlay runtime handles the click in-page and calls
      // __orcaGrabResolve() which is wired by the 'awaitClick' script to
      // resolve the executeJavaScript Promise with the extracted payload.
      // Main just needs to run that script and await its result.
      const awaitGuestClick = async (): Promise<void> => {
        try {
          const rawPayload = await guest.executeJavaScript(buildGuestOverlayScript('awaitClick'))
          if (!rawPayload || typeof rawPayload !== 'object') {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
            return
          }
          // Why: the guest wraps right-click results in { __orcaContextMenu, payload }
          // so the renderer can show the full action dropdown instead of auto-copying.
          const isContextMenu =
            '__orcaContextMenu' in (rawPayload as Record<string, unknown>) &&
            (rawPayload as Record<string, unknown>).__orcaContextMenu === true
          const payloadSource = isContextMenu
            ? (rawPayload as Record<string, unknown>).payload
            : rawPayload
          const payload = clampGrabPayload(payloadSource)
          if (!payload) {
            settleOnce({ opId, kind: 'error', reason: 'Guest returned invalid payload structure' })
            return
          }
          settleOnce({
            opId,
            kind: isContextMenu ? 'context-selected' : 'selected',
            payload
          })
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Selection failed'
          // Distinguish cancellation from errors
          if (message.includes('cancelled')) {
            settleOnce({ opId, kind: 'cancelled', reason: 'user' })
          } else {
            settleOnce({ opId, kind: 'error', reason: message })
          }
        }
      }

      // --- Auto-cancel on top-level navigation ---
      // Why: only cancel on main-frame navigations. Subframe navigations
      // (e.g., iframe ads loading) should not spuriously cancel the grab.
      const handleNavigation = (
        _event: unknown,
        _url: unknown,
        _isInPlace: unknown,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame) {
          settleOnce({ opId, kind: 'cancelled', reason: 'navigation' })
        }
      }

      // --- Auto-cancel on guest destruction ---
      const handleDestroyed = (): void => {
        settleOnce({ opId, kind: 'cancelled', reason: 'evicted' })
      }

      // --- Hard timeout ---
      const timeoutId = setTimeout(() => {
        settleOnce({ opId, kind: 'cancelled', reason: 'timeout' })
      }, GRAB_OP_TIMEOUT_MS)

      // Install listeners
      guest.on('did-start-navigation', handleNavigation)
      guest.on('destroyed', handleDestroyed)

      const cleanup = (preserveOverlay?: boolean): void => {
        try {
          guest.off('did-start-navigation', handleNavigation)
          guest.off('destroyed', handleDestroyed)
        } catch {
          // Why: the guest may already be destroyed during teardown.
          // Cleanup is best-effort.
        }
        // Why: skip teardown injection when (a) the op is being replaced by a
        // new op (skipTeardown), or (b) the selection succeeded and the overlay
        // should stay visible while the copy menu is shown (preserveOverlay).
        if (op.skipTeardown || preserveOverlay) {
          return
        }
        // Tell the guest to remove the overlay
        try {
          if (!guest.isDestroyed()) {
            void guest.executeJavaScript(buildGuestOverlayScript('teardown'))
          }
        } catch {
          // Best-effort overlay removal
        }
      }

      const op: ActiveGrabOp = {
        opId,
        browserTabId,
        guestWebContentsId,
        resolve: settleOnce,
        cleanup
      }
      this.activeGrabOps.set(browserTabId, op)

      // Start awaiting the click in the guest
      void awaitGuestClick()
    })
  }

  /**
   * Cancel an active grab operation for the given tab.
   */
  cancelGrabOp(browserTabId: string, reason: BrowserGrabCancelReason): void {
    const op = this.activeGrabOps.get(browserTabId)
    if (!op) {
      return
    }
    // Why: settleOnce (op.resolve) already calls op.cleanup() and deletes the
    // map entry. Calling them again here would double-inject the teardown script.
    op.resolve({ opId: op.opId, kind: 'cancelled', reason })
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
    try {
      // Why: the rect comes from the renderer via IPC. Validate that all fields
      // are finite numbers before using them in arithmetic, so NaN cannot reach
      // Electron's image.crop() and cause undefined behavior.
      const safeN = (n: unknown, fallback = 0): number =>
        typeof n === 'number' && Number.isFinite(n) ? n : fallback
      const safeRect = {
        x: safeN(rect.x),
        y: safeN(rect.y),
        width: safeN(rect.width),
        height: safeN(rect.height)
      }

      // Why: hide the grab overlay before capturing so the highlight box and
      // label don't appear in the screenshot. The overlay is restored after.
      // Wrapped in try/finally so the overlay is always restored even if
      // capturePage() throws (e.g., guest destroyed mid-capture).
      await guest
        .executeJavaScript(
          `(function(){ var g = window.__orcaGrab; if (g && g.host) g.host.style.display = 'none'; })()`
        )
        .catch(() => {})
      let image: Electron.NativeImage
      try {
        image = await guest.capturePage()
      } finally {
        await guest
          .executeJavaScript(
            `(function(){ var g = window.__orcaGrab; if (g && g.host) g.host.style.display = ''; })()`
          )
          .catch(() => {})
      }
      if (image.isEmpty()) {
        return null
      }

      const bitmapSize = image.getSize()
      // Why: capturePage returns a bitmap in physical pixels. The grab rect is
      // in CSS pixels. To map between them we need the combined scale factor
      // (zoomFactor * deviceScaleFactor). Rather than using the primary display
      // (which is wrong on multi-monitor setups with mixed DPI), we derive the
      // scale factor empirically: ask the guest for its CSS viewport width, then
      // compute scaleFactor = bitmapWidth / viewportCSSWidth. This is correct
      // regardless of which display the window is on.
      const viewportCSSWidth: number = await guest.executeJavaScript('window.innerWidth')
      if (!viewportCSSWidth || viewportCSSWidth <= 0) {
        return null
      }
      const scaleFactor = bitmapSize.width / viewportCSSWidth

      // Map CSS-pixel rect to bitmap coordinates
      const cropX = Math.max(0, Math.round(safeRect.x * scaleFactor))
      const cropY = Math.max(0, Math.round(safeRect.y * scaleFactor))
      const cropW = Math.min(bitmapSize.width - cropX, Math.round(safeRect.width * scaleFactor))
      const cropH = Math.min(bitmapSize.height - cropY, Math.round(safeRect.height * scaleFactor))

      if (cropW <= 0 || cropH <= 0) {
        return null
      }

      const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
      const pngBuffer = cropped.toPNG()

      // Enforce screenshot byte budget
      if (pngBuffer.byteLength > GRAB_BUDGET.screenshotMaxBytes) {
        // Why: downscaling would add complexity for v1. Fail closed to
        // "no screenshot" rather than send an oversized payload.
        return null
      }

      const dataUrl = `data:image/png;base64,${pngBuffer.toString('base64')}`
      // Why: cropW/cropH are in physical pixels (bitmap coordinates) but the
      // rest of the grab payload uses CSS pixels. Divide by scaleFactor so the
      // screenshot dimensions are consistent with rectViewport/rectPage.
      return {
        mimeType: 'image/png',
        dataUrl,
        width: Math.round(cropW / scaleFactor),
        height: Math.round(cropH / scaleFactor)
      }
    } catch {
      // Why: screenshot capture can fail if the guest is being torn down
      // or the compositor surface is not available. Fail closed.
      return null
    }
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
    const handler = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
      const pageUrl = guest.getURL()
      const linkUrl = params.linkURL || ''

      const template: Electron.MenuItemConstructorOptions[] = []

      if (linkUrl) {
        const externalLinkUrl = normalizeExternalBrowserUrl(linkUrl)
        template.push(
          {
            label: 'Open Link In Default Browser',
            enabled: Boolean(externalLinkUrl && externalLinkUrl !== 'about:blank'),
            click: () => {
              this.openValidatedExternal(linkUrl)
            }
          },
          {
            label: 'Copy Link Address',
            click: () => {
              clipboard.writeText(linkUrl)
            }
          },
          { type: 'separator' }
        )
      }

      const externalPageUrl = normalizeExternalBrowserUrl(pageUrl)

      template.push(
        {
          label: 'Back',
          enabled: guest.canGoBack(),
          click: () => guest.goBack()
        },
        {
          label: 'Forward',
          enabled: guest.canGoForward(),
          click: () => guest.goForward()
        },
        {
          label: 'Reload',
          click: () => guest.reload()
        },
        { type: 'separator' },
        {
          label: 'Open Page In Default Browser',
          enabled: Boolean(externalPageUrl && externalPageUrl !== 'about:blank'),
          click: () => {
            this.openValidatedExternal(pageUrl)
          }
        },
        {
          label: 'Copy Page URL',
          enabled: Boolean(pageUrl),
          click: () => {
            clipboard.writeText(pageUrl)
          }
        },
        { type: 'separator' },
        {
          label: 'Inspect Page',
          click: () => {
            void this.openDevTools(browserTabId)
          }
        }
      )

      Menu.buildFromTemplate(template).popup()
    }

    guest.on('context-menu', handler)
    this.contextMenuCleanupByTabId.set(browserTabId, () => {
      try {
        guest.off('context-menu', handler)
      } catch {
        // Why: browser tabs can outlive the guest webContents briefly during
        // teardown. Cleanup should be best-effort instead of throwing while the
        // IDE is closing a tab.
      }
    })
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

    const handler = (event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') {
        return
      }
      const isMod = process.platform === 'darwin' ? input.meta : input.control
      if (!isMod || input.shift || input.alt || input.key.toLowerCase() !== 'c') {
        return
      }

      void guest
        .executeJavaScript(`(() => {
          const active = document.activeElement
          const tag = active?.tagName
          const isEditable =
            active instanceof HTMLInputElement ||
            active instanceof HTMLTextAreaElement ||
            active?.isContentEditable === true ||
            tag === 'SELECT' ||
            tag === 'IFRAME'
          if (isEditable) {
            return false
          }
          const selection = window.getSelection()
          return Boolean(selection && selection.type === 'Range' && selection.toString().trim().length > 0)
            ? false
            : true
        })()`)
        .then((shouldToggle) => {
          if (!shouldToggle) {
            return
          }
          event.preventDefault()
          const rendererWcId = this.rendererWebContentsIdByTabId.get(browserTabId)
          if (!rendererWcId) {
            return
          }
          const rendererWc = webContents.fromId(rendererWcId)
          if (!rendererWc || rendererWc.isDestroyed()) {
            return
          }
          rendererWc.send('browser:grabModeToggle', browserTabId)
        })
        .catch(() => {
          // Why: shortcut forwarding is best-effort. Guest teardown or a
          // transient executeJavaScript failure should not break normal copy.
        })
    }

    guest.on('before-input-event', handler)
    this.grabShortcutCleanupByTabId.set(browserTabId, () => {
      try {
        guest.off('before-input-event', handler)
      } catch {
        // Why: browser tabs can outlive the guest webContents briefly during
        // teardown. Cleanup should be best-effort.
      }
    })
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

    const handler = (_event: Electron.Event, input: Electron.Input): void => {
      if (input.type !== 'keyDown') {
        return
      }
      // Why: browser guests need a broader modifier-chord gate than the main
      // window because they also forward guest-specific tab shortcuts
      // (Cmd/Ctrl+T/W/Shift+B/Shift+[ / ]) in addition to the shared allowlist
      // handled by resolveWindowShortcutAction().
      if (!isWindowShortcutModifierChord(input, process.platform)) {
        return
      }

      // Why: centralizing the shared subset still keeps guest forwarding in
      // lockstep with the main window for the chords that must never steal
      // readline control input above the terminal.
      const action = resolveWindowShortcutAction(input, process.platform)

      const rendererWcId = this.rendererWebContentsIdByTabId.get(browserTabId)
      if (!rendererWcId) {
        return
      }
      const rendererWc = webContents.fromId(rendererWcId)
      if (!rendererWc || rendererWc.isDestroyed()) {
        return
      }

      if (input.code === 'KeyB' && input.shift) {
        rendererWc.send('ui:newBrowserTab')
      } else if (input.code === 'KeyT' && !input.shift) {
        rendererWc.send('ui:newTerminalTab')
      } else if (input.code === 'KeyW' && !input.shift) {
        rendererWc.send('ui:closeActiveTab')
      } else if (input.shift && (input.code === 'BracketRight' || input.code === 'BracketLeft')) {
        rendererWc.send('ui:switchTab', input.code === 'BracketRight' ? 1 : -1)
      } else if (action?.type === 'toggleWorktreePalette') {
        rendererWc.send('ui:toggleWorktreePalette')
      } else if (action?.type === 'openQuickOpen') {
        rendererWc.send('ui:openQuickOpen')
      } else if (action?.type === 'jumpToWorktreeIndex') {
        rendererWc.send('ui:jumpToWorktreeIndex', action.index)
      } else {
        return
      }
      // Why: preventDefault stops the guest page from also processing the chord
      // (e.g. Cmd+T opening a browser-internal new-tab page).
      _event.preventDefault()
    }

    guest.on('before-input-event', handler)
    this.shortcutForwardingCleanupByTabId.set(browserTabId, () => {
      try {
        guest.off('before-input-event', handler)
      } catch {
        // Why: best-effort — guest may already be destroyed during teardown.
      }
    })
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
