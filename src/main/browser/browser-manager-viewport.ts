import { webContents } from 'electron'
import {
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  buildBrowserAnnotationViewportBridgeScript,
  type BrowserAnnotationViewportBridgeOptions
} from '../../shared/browser-annotation-viewport-bridge'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import { BrowserManagerDownloadLifecycle } from './browser-manager-download-lifecycle'
import { sendGuestCdpCommand } from './guest-cdp-command'

// Omit maxTouchPoints when disabling: Chromium rejects 0 even then (#22749).
const TOUCH_EMULATION_DISABLED = { enabled: false } as const

export abstract class BrowserManagerViewport extends BrowserManagerDownloadLifecycle {
  async openDevTools(
    browserTabId: string,
    inspectAt?: { x: number; y: number },
    rendererWebContentsId?: number
  ): Promise<boolean> {
    const webContentsId =
      rendererWebContentsId === undefined
        ? this.webContentsIdByTabId.get(browserTabId)
        : this.guestIdForRenderer(browserTabId, rendererWebContentsId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.selectGuestForEvent(webContentsId)
      this.unregisterGuest(browserTabId)
      return false
    }
    // Offscreen DevTools would open on the server desktop without a route back to the client.
    if (this.offscreenGuestIds.has(webContentsId)) {
      return false
    }
    guest.openDevTools({ mode: 'detach' })
    if (inspectAt) {
      // Open detached first: inspectElement alone uses the saved dock mode, unsupported by guests (#7399).
      guest.inspectElement(inspectAt.x, inspectAt.y)
    }
    return true
  }

  // Never detach here: other CDP clients, including the agent bridge, would lose their state.
  async setViewportOverride(
    browserTabId: string,
    override: BrowserViewportOverride | null,
    rendererWebContentsId?: number
  ): Promise<boolean> {
    const expectedWebContentsId =
      rendererWebContentsId === undefined
        ? this.webContentsIdByTabId.get(browserTabId)
        : this.guestIdForRenderer(browserTabId, rendererWebContentsId)
    if (expectedWebContentsId === undefined) {
      return false
    }
    // Record intent now for panning; update applied metrics only after CDP accepts them.
    const previous = this.viewportPresetsByGuestId.get(expectedWebContentsId)
    this.viewportPresetsByGuestId.set(expectedWebContentsId, {
      guestWebContentsId: expectedWebContentsId,
      requested: override,
      applied: previous?.guestWebContentsId === expectedWebContentsId ? previous.applied : null
    })
    // Host resize precedes CDP completion; discard stale wheel bounds until the renderer updates them.
    this.viewportScrollStatesByGuestId.delete(expectedWebContentsId)
    const prev = this.viewportOpsByGuestId.get(expectedWebContentsId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetViewportOverrideImpl(browserTabId, override, expectedWebContentsId))
    this.viewportOpsByGuestId.set(expectedWebContentsId, next)
    try {
      return await next
    } finally {
      // A later request may own the tail; deleting it would break serialization.
      if (this.viewportOpsByGuestId.get(expectedWebContentsId) === next) {
        this.viewportOpsByGuestId.delete(expectedWebContentsId)
      }
    }
  }

  async setAnnotationViewportBridge(
    browserTabId: string,
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    const guest = resolveGuest()
    if (!guest) {
      return false
    }
    const key = this.annotationViewportBridgeKey(browserTabId, guest.id)
    const prev = this.annotationViewportBridgeOpsByTabId.get(key) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => {
        // Document invalidation retires queued geometry.
        if (this.annotationViewportBridgeOpsByTabId.get(key) !== next) {
          return false
        }
        return this.doSetAnnotationViewportBridgeImpl(options, resolveGuest)
      })
    this.annotationViewportBridgeOpsByTabId.set(key, next)
    try {
      return await next
    } finally {
      if (this.annotationViewportBridgeOpsByTabId.get(key) === next) {
        this.annotationViewportBridgeOpsByTabId.delete(key)
      }
    }
  }

  // Resolve after queueing: document and browsing guests may have changed while this op waited.
  protected async doSetAnnotationViewportBridgeImpl(
    options: BrowserAnnotationViewportBridgeOptions,
    resolveGuest: () => Electron.WebContents | null
  ): Promise<boolean> {
    // The resolver owns stale cleanup; a healthy guest with mismatched ownership must stay alive.
    const guest = resolveGuest()
    if (!guest || guest.isDestroyed()) {
      return false
    }

    try {
      // Isolate the bridge token from page scripts.
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
    webContentsId: number
  ): Promise<boolean> {
    if (!this.isRegisteredPageGuest(browserTabId, webContentsId)) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      this.selectGuestForEvent(webContentsId)
      this.unregisterGuest(browserTabId)
      return false
    }

    try {
      if (!guest.debugger.isAttached()) {
        guest.debugger.attach('1.3')
      }
    } catch (err) {
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
    // Record before awaiting again so a later detach cannot be overwritten by stale applied metrics.
    if (!this.isRegisteredPageGuest(browserTabId, webContentsId)) {
      return false
    }
    if (metricsApplied) {
      this.recordAppliedViewportOverride(browserTabId, webContentsId, override)
    }
    const touchApplied = await this.runViewportEmulationStep(browserTabId, 'touch emulation', () =>
      dbg.sendCommand(
        'Emulation.setTouchEmulationEnabled',
        override?.mobile ? { enabled: true, maxTouchPoints: 5 } : TOUCH_EMULATION_DISABLED
      )
    )
    if (!this.isRegisteredPageGuest(browserTabId, webContentsId)) {
      return false
    }
    // Match identity to accepted device metrics even when the requested preset fails.
    const identityApplied = await this.runViewportEmulationStep(browserTabId, 'identity', () =>
      this.retargetTabIdentity(guest, this.resolveTabNavigationUrl(guest))
    )
    return (
      metricsApplied &&
      touchApplied &&
      identityApplied &&
      this.isRegisteredPageGuest(browserTabId, webContentsId)
    )
  }

  private async runViewportEmulationStep(
    browserTabId: string,
    step: string,
    send: () => Promise<unknown>
  ): Promise<boolean> {
    try {
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
