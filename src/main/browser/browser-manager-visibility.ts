import { rendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { BrowserManagerState } from './browser-manager-state'
import { focusGuardUnavailableError, guardPaneFocusForAgentInput } from './agent-input-focus-guard'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  private readonly capturePaintHolds = new Map<number, number>()

  // Do not await the renderer: minimized or throttled windows must not stall frame capture.
  holdPaintForCapture(guestWebContentsId: number): () => void {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = this.getRendererContextForGuest(guestWebContentsId)?.renderer
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      return () => {}
    }
    const holds = this.capturePaintHolds.get(guestWebContentsId) ?? 0
    this.capturePaintHolds.set(guestWebContentsId, holds + 1)
    if (holds === 0) {
      renderer.send('browser:capturePaintHold', { browserPageId, held: true })
    }
    // Lift throttling so capture retries do not repeatedly wait on delayed parking changes.
    const releaseThrottle = rendererPublicationThrottle.acquire(renderer)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseThrottle()
      const remaining = (this.capturePaintHolds.get(guestWebContentsId) ?? 1) - 1
      if (remaining > 0) {
        this.capturePaintHolds.set(guestWebContentsId, remaining)
        return
      }
      this.capturePaintHolds.delete(guestWebContentsId)
      if (!renderer.isDestroyed()) {
        renderer.send('browser:capturePaintHold', { browserPageId, held: false })
      }
    }
  }

  // Agent input moves Chromium focus into the guest; the pane restores the user's focus.
  guardUserFocusForAgentInput(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = this.getRendererContextForGuest(guestWebContentsId)?.renderer
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      return Promise.reject(focusGuardUnavailableError())
    }
    return guardPaneFocusForAgentInput(renderer, browserPageId)
  }
}
