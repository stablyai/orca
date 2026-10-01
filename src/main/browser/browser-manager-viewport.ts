import { webContents } from 'electron'
import {
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  buildBrowserAnnotationViewportBridgeScript,
  type BrowserAnnotationViewportBridgeOptions
} from '../../shared/browser-annotation-viewport-bridge'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import { BrowserManagerDownloadLifecycle } from './browser-manager-download-lifecycle'
import { sendGuestCdpCommand } from './guest-cdp-command'

// Why no maxTouchPoints: Chromium rejects values outside 1..16 even when disabling, which left
// touch emulation (and no-hover media features) on after leaving a mobile preset (#22749).
const TOUCH_EMULATION_DISABLED = { enabled: false } as const

export abstract class BrowserManagerViewport extends BrowserManagerDownloadLifecycle {
  // Why: guests are isolated from Orca's preload bridge, so main owns the devtools escape hatch after a tab→guest lookup.
  async openDevTools(browserTabId: string): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }
    // Offscreen guests have no visible window on this desktop; detaching DevTools would open it
    // on the host display with no route back to the remote client.
    if (this.offscreenGuestIds.has(webContentsId)) {
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    return true
  }

  // Why: emulate viewport via CDP; never detach the debugger here or the agent bridge's per-guest state is cleared.
  async setViewportOverride(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    // Why: chain per-tab so rapid toggles don't interleave CDP commands and the last-requested override wins.
    const expectedWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (expectedWebContentsId !== undefined) {
      // Record the request before CDP runs so host panning follows it at once. What is applied only
      // moves once Chromium accepts it. The guest id fence keeps both off a replacement guest.
      const previous = this.viewportPresetByTabId.get(browserTabId)
      this.viewportPresetByTabId.set(browserTabId, {
        guestWebContentsId: expectedWebContentsId,
        requested: override,
        applied: previous?.guestWebContentsId === expectedWebContentsId ? previous.applied : null
      })
    }
    // The renderer resizes the host before CDP completes; discard the old geometry until it
    // reports the new pane bounds so a pending preset cannot route wheel input using stale limits.
    this.viewportScrollStateByTabId.delete(browserTabId)
    const prev = this.viewportOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetViewportOverrideImpl(browserTabId, override, expectedWebContentsId))
    this.viewportOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      // Why: only clear if we're still the tail; a later call may have replaced the entry, and deleting would break serialization.
      if (this.viewportOpsByTabId.get(browserTabId) === next) {
        this.viewportOpsByTabId.delete(browserTabId)
      }
    }
  }

  async setAnnotationViewportBridge(
    browserTabId: string,
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    const prev = this.annotationViewportBridgeOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetAnnotationViewportBridgeImpl(options, resolveGuest))
    this.annotationViewportBridgeOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      if (this.annotationViewportBridgeOpsByTabId.get(browserTabId) === next) {
        this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
      }
    }
  }

  // Why the caller resolves the guest: the same bridge serves browsing pages and workspace
  // documents, which live in different halves of the page registry.
  // Why a resolver and not the guest itself: this op may have waited behind another one, and a
  // cross-process navigation meanwhile swaps the tab's contents without destroying the old one —
  // injecting into the guest the request named would bridge a page nobody is looking at.
  // Why no tab id: with teardown gone this reaches only the guest the resolver hands back, and
  // taking an id it cannot act on would invite the next reader to act on it.
  protected async doSetAnnotationViewportBridgeImpl(
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    // Why no teardown here: the resolver already unregisters a page whose guest died, and the only
    // case it uniquely leaves is an ownership mismatch on a healthy page — where tearing down would
    // cancel that page's in-flight downloads and grabs over a request that was merely misaddressed.
    const guest = resolveGuest()
    if (!guest || guest.isDestroyed()) {
      return false
    }

    try {
      // Why: run the scroll bridge in an isolated world so page scripts can't read the per-tab token or tamper with it.
      await guest.executeJavaScriptInIsolatedWorld(
        BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
        [{ code: buildBrowserAnnotationViewportBridgeScript(options) }],
        false
      )
      return true
    } catch {
      return false
    }
  }

  protected async doSetViewportOverrideImpl(
    browserTabId: string,
    override: BrowserViewportOverride | null,
    expectedWebContentsId: number | undefined
  ): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId || webContentsId !== expectedWebContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      // Why: a stale guest must clear every per-tab registry entry, not just the WebContents maps.
      this.unregisterGuest(browserTabId)
      return false
    }

    try {
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch (err) {
      // Why: attach throws if DevTools is open on the guest; log context so this failure mode is diagnosable.
      console.warn('[browser-manager] setViewportOverride: failed to attach debugger', {
        browserTabId,
        webContentsId,
        error: err instanceof Error ? err.message : String(err)
      })
      return false
    }

    const dbg = guest.debugger
    const metricsApplied = await this.runViewportEmulationStep(
      browserTabId,
      'device metrics',
      () =>
        override
          ? sendGuestCdpCommand(guest, 'Emulation.setDeviceMetricsOverride', {
              width: override.width,
              height: override.height,
              deviceScaleFactor: override.deviceScaleFactor,
              mobile: override.mobile
            })
          : dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {})
    )
    // Why record before any further await: a debugger detach clears the metrics, and its handler
    // must land after this write, not be overwritten by it.
    if (metricsApplied) {
      this.recordAppliedViewportOverride(browserTabId, webContentsId, override)
    }
    const touchApplied = await this.runViewportEmulationStep(browserTabId, 'touch emulation', () =>
      dbg.sendCommand(
        'Emulation.setTouchEmulationEnabled',
        override?.mobile ? { enabled: true, maxTouchPoints: 5 } : TOUCH_EMULATION_DISABLED
      )
    )
    if (this.webContentsIdByTabId.get(browserTabId) !== webContentsId) {
      return false
    }
    // Why: identity follows the device metrics Chromium actually holds, not the request, so a failed
    // metrics write never pairs a phone identity with a desktop viewport, or the reverse.
    const identityApplied = await this.runViewportEmulationStep(browserTabId, 'identity', () =>
      this.retargetTabIdentity(guest, this.resolveTabNavigationUrl(guest))
    )
    return (
      metricsApplied &&
      touchApplied &&
      identityApplied &&
      this.webContentsIdByTabId.get(browserTabId) === webContentsId
    )
  }

  private async runViewportEmulationStep(
    browserTabId: string,
    step: string,
    send: () => Promise<unknown>
  ): Promise<boolean> {
    try {
      // A step that reports its own failure resolves false rather than throwing.
      return (await send()) !== false
    } catch (error) {
      console.warn(`[browser-manager] setViewportOverride: ${step} failed`, {
        browserTabId,
        error: error instanceof Error ? error.message : String(error)
      })
      return false
    }
  }
}
