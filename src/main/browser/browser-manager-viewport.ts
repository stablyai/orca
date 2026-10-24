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
  async openDevTools(browserTabId: string, inspectAt?: { x: number; y: number }): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
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
    override: BrowserViewportOverride | null
  ): Promise<boolean> {
    const expectedWebContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (expectedWebContentsId !== undefined) {
      // Record intent now for panning; update applied metrics only after CDP accepts them.
      const previous = this.viewportPresetByTabId.get(browserTabId)
      this.viewportPresetByTabId.set(browserTabId, {
        guestWebContentsId: expectedWebContentsId,
        requested: override,
        applied: previous?.guestWebContentsId === expectedWebContentsId ? previous.applied : null
      })
    }
    // Host resize precedes CDP completion; discard stale wheel bounds until the renderer updates them.
    this.viewportScrollStateByTabId.delete(browserTabId)
    const prev = this.viewportOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev
      .catch(() => {})
      .then(() => this.doSetViewportOverrideImpl(browserTabId, override, expectedWebContentsId))
    this.viewportOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      // A later request may own the tail; deleting it would break serialization.
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
      .then(() => {
        // Document invalidation retires queued geometry.
        if (this.annotationViewportBridgeOpsByTabId.get(browserTabId) !== next) {
          return false
        }
        return this.doSetAnnotationViewportBridgeImpl(options, resolveGuest)
      })
    this.annotationViewportBridgeOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      if (this.annotationViewportBridgeOpsByTabId.get(browserTabId) === next) {
        this.annotationViewportBridgeOpsByTabId.delete(browserTabId)
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
    expectedWebContentsId: number | undefined
  ): Promise<boolean> {
    const webContentsId = this.webContentsIdByTabId.get(browserTabId)
    if (!webContentsId || webContentsId !== expectedWebContentsId) {
      return false
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
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
    // Match identity to accepted device metrics even when the requested preset fails.
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
