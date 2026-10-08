import { webContents } from 'electron'
import { rendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { BrowserManagerState } from './browser-manager-state'
import { OffscreenPaintLease } from './offscreen-paint-lease'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  // Why: page id -> active capture count; the renderer hears only the first hold and the last release.
  private readonly capturePaintHolds = new Map<string, number>()
  private readonly offscreenPaintLease = new OffscreenPaintLease()

  // Why: only pixel capture needs a drawn guest. One-way so a minimized or throttled desktop renderer
  // can't stall the capture; the capture itself retries until the page produces a frame.
  holdPaintForCapture(guestWebContentsId: number): () => void {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = browserPageId ? this.resolveRendererForBrowserTab(browserPageId) : null
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      // Why: offscreen guests have no hosting renderer to ask for paint — the lease lifts the
      // guest's own throttling for the capture instead; non-offscreen misses stay no-ops.
      return this.acquireOffscreenPaint(guestWebContentsId)
    }
    const holds = this.capturePaintHolds.get(browserPageId) ?? 0
    this.capturePaintHolds.set(browserPageId, holds + 1)
    if (holds === 0) {
      renderer.send('browser:capturePaintHold', { browserPageId, held: true })
    }
    // Why: a throttled renderer applies the parking change late, which every retry would pay for.
    const releaseThrottle = rendererPublicationThrottle.acquire(renderer)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseThrottle()
      const remaining = (this.capturePaintHolds.get(browserPageId) ?? 1) - 1
      if (remaining > 0) {
        this.capturePaintHolds.set(browserPageId, remaining)
        return
      }
      this.capturePaintHolds.delete(browserPageId)
      if (!renderer.isDestroyed()) {
        renderer.send('browser:capturePaintHold', { browserPageId, held: false })
      }
    }
  }

  /** Lifts background throttling on an offscreen guest while the returned release is held; no-op for unknown/destroyed ids. */
  acquireOffscreenPaint(guestWebContentsId: number): () => void {
    const guest = webContents.fromId(guestWebContentsId)
    if (!guest || guest.isDestroyed() || !this.offscreenGuestIds.has(guestWebContentsId)) {
      return () => {}
    }
    return this.offscreenPaintLease.acquire(guest)
  }

  /** True while a paint hold is active on this offscreen guest (screenshot/screencast in flight). */
  isPaintLeaseHeld(guestWebContentsId: number): boolean {
    return this.offscreenPaintLease.isHeld(guestWebContentsId)
  }
}
