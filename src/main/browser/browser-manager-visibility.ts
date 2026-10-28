import { rendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { BrowserManagerState } from './browser-manager-state'
import { focusGuardUnavailableError, guardPaneFocusForAgentInput } from './agent-input-focus-guard'
import {
  BrowserAgentActivity,
  type AgentCommandLease,
  type AgentPointerInput
} from './browser-agent-activity'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  private readonly capturePaintHolds = new Map<string, number>()
  protected readonly agentActivity = new BrowserAgentActivity({
    pageIdForGuest: (guestWebContentsId) =>
      this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId),
    rendererForPage: (browserPageId) => this.resolveRendererForBrowserTab(browserPageId),
    worktreeForPage: (browserPageId) => this.worktreeIdByTabId.get(browserPageId) ?? null
  })

  /** Holds the page's agent marking for one queued command, from queueing until it settles. */
  beginAgentCommand(browserPageId: string): AgentCommandLease {
    return this.agentActivity.beginCommand(browserPageId)
  }

  // Show the agent's pointer landing before the input it precedes reaches the page.
  showAgentPointer(guest: Electron.WebContents, input: AgentPointerInput): Promise<void> {
    return this.agentActivity.showPointer(guest, input)
  }

  // Do not await the renderer: minimized or throttled windows must not stall frame capture.
  holdPaintForCapture(guestWebContentsId: number): () => void {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = browserPageId ? this.resolveRendererForBrowserTab(browserPageId) : null
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      return () => {}
    }
    const holds = this.capturePaintHolds.get(browserPageId) ?? 0
    this.capturePaintHolds.set(browserPageId, holds + 1)
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

  // Agent input moves Chromium focus into the guest; the pane restores the user's focus.
  guardUserFocusForAgentInput(guestWebContentsId: number): Promise<() => void> {
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = browserPageId ? this.resolveRendererForBrowserTab(browserPageId) : null
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      return Promise.reject(focusGuardUnavailableError())
    }
    return guardPaneFocusForAgentInput(renderer, browserPageId)
  }
}
