import { webContents } from 'electron'
import {
  BROWSER_ANNOTATION_VIEWPORT_BRIDGE_WORLD_ID,
  buildBrowserAnnotationViewportBridgeScript,
  type BrowserAnnotationViewportBridgeOptions
} from '../../shared/browser-annotation-viewport-bridge'
import type { BrowserViewportOverride } from '../../shared/browser-workspace-types'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'
import { BrowserManagerDownloadLifecycle } from './browser-manager-download-lifecycle'

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
      // Keep host panning available while CDP applies the requested dimensions. The guest id fence
      // prevents this intent from leaking to a replacement guest; clearing the preset removes it.
      this.viewportPresetActiveByTabId.set(browserTabId, {
        guestWebContentsId: expectedWebContentsId,
        active: override !== null
      })
    }
    // The renderer resizes the host before CDP completes; discard the old geometry until it
    // reports the new pane bounds so a pending preset cannot route wheel input using stale limits.
    this.viewportScrollStateByTabId.delete(browserTabId)
    const previousOverride = this.viewportOverrideByTabId.get(browserTabId)
    const previousUaMobile = this.viewportUaOverrideMobileByTabId.get(browserTabId)
    const generation = this.advanceViewportOverrideRequestGeneration(browserTabId)
    this.applyLatestViewportOverrideIntent(browserTabId, override)
    return this.enqueueViewportOperation(browserTabId, () =>
      this.doSetViewportOverrideImpl(
        browserTabId,
        override,
        expectedWebContentsId,
        generation,
        previousOverride,
        previousUaMobile
      )
    )
  }

  protected advanceViewportOverrideRequestGeneration(browserTabId: string): number {
    const generation = (this.viewportOverrideRequestGenerationByTabId.get(browserTabId) ?? 0) + 1
    this.viewportOverrideRequestGenerationByTabId.set(browserTabId, generation)
    return generation
  }

  protected isLatestViewportOverrideRequest(browserTabId: string, generation: number): boolean {
    return this.viewportOverrideRequestGenerationByTabId.get(browserTabId) === generation
  }

  protected applyLatestViewportOverrideIntent(
    browserTabId: string,
    override: BrowserViewportOverride | null
  ): void {
    if (override) {
      this.viewportOverrideByTabId.set(browserTabId, { ...override })
      if (this.userAgentModeByPageId.get(browserTabId) !== 'native') {
        this.viewportUaOverrideMobileByTabId.set(browserTabId, override.mobile)
      } else {
        this.viewportUaOverrideMobileByTabId.delete(browserTabId)
      }
      return
    }
    this.viewportOverrideByTabId.delete(browserTabId)
    this.viewportUaOverrideMobileByTabId.delete(browserTabId)
  }

  protected async enqueueViewportOperation(
    browserTabId: string,
    operation: () => Promise<boolean>
  ): Promise<boolean> {
    const prev = this.viewportOpsByTabId.get(browserTabId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(operation)
    this.viewportOpsByTabId.set(browserTabId, next)
    try {
      return await next
    } finally {
      if (this.viewportOpsByTabId.get(browserTabId) === next) {
        this.viewportOpsByTabId.delete(browserTabId)
      }
    }
  }

  protected override reapplyStandingViewportOverride(browserTabId: string): void {
    void this.enqueueViewportOperation(browserTabId, async () => {
      const override = this.viewportOverrideByTabId.get(browserTabId)
      if (!override) {
        return false
      }
      return this.doSetViewportOverrideImpl(
        browserTabId,
        override,
        this.webContentsIdByTabId.get(browserTabId),
        this.viewportOverrideRequestGenerationByTabId.get(browserTabId) ?? 0
      )
    }).catch(() => {})
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
    expectedWebContentsId: number | undefined,
    generation: number,
    previousOverride?: BrowserViewportOverride,
    previousUaMobile?: boolean
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
    const stillOnExpectedGuest = (): boolean =>
      this.webContentsIdByTabId.get(browserTabId) === webContentsId
    try {
      if (override) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: override.width,
          height: override.height,
          deviceScaleFactor: override.deviceScaleFactor,
          mobile: override.mobile
        })
        if (!stillOnExpectedGuest()) {
          return false
        }
        if (this.isLatestViewportOverrideRequest(browserTabId, generation)) {
          this.viewportPresetActiveByTabId.set(browserTabId, {
            guestWebContentsId: webContentsId,
            active: true
          })
        }
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: override.mobile,
          maxTouchPoints: override.mobile ? 5 : 0
        })
        if (!stillOnExpectedGuest()) {
          return false
        }
        // Why: viewport sizing must not override a profile's explicit native-UA identity.
        if (this.userAgentModeByPageId.get(browserTabId) !== 'native') {
          // Why: same sender as the navigation path, so both resolve the tab's host identically.
          await this.sendViewportUserAgentOverride(guest, override.mobile)
        }
      } else {
        await dbg.sendCommand('Emulation.clearDeviceMetricsOverride', {})
        if (this.webContentsIdByTabId.get(browserTabId) === webContentsId) {
          this.viewportPresetActiveByTabId.set(browserTabId, {
            guestWebContentsId: webContentsId,
            active: false
          })
        }
        await dbg.sendCommand('Emulation.setTouchEmulationEnabled', {
          enabled: false,
          maxTouchPoints: 0
        })
        try {
          if (this.authUserAgentOverrideStateByGuestId.has(guest.id)) {
            const url = this.resolveTabNavigationUrl(guest)
            const restored = await this.applyAuthUserAgentOverrideOverCdp(
              guest,
              false,
              url,
              isGoogleAuthUrl(url) ? googleAuthUserAgent() : guest.session.getUserAgent()
            )
            if (!restored) {
              throw new Error('Failed to preserve auth user agent')
            }
          } else {
            // Why: passing an empty string restores the session default UA.
            await dbg.sendCommand('Emulation.setUserAgentOverride', { userAgent: '' })
          }
        } catch (error) {
          if (this.isLatestViewportOverrideRequest(browserTabId, generation)) {
            if (previousUaMobile !== undefined) {
              this.viewportUaOverrideMobileByTabId.set(browserTabId, previousUaMobile)
            }
            if (previousOverride) {
              this.viewportOverrideByTabId.set(browserTabId, previousOverride)
            }
          }
          throw error
        }
      }
      if (this.webContentsIdByTabId.get(browserTabId) !== webContentsId) {
        return false
      }
      return true
    } catch {
      return false
    }
  }
}
