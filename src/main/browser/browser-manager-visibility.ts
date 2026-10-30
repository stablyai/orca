import { webContents } from 'electron'
import { rendererPublicationThrottle } from '../window/renderer-publication-throttle'
import { BrowserManagerState } from './browser-manager-state'
import { focusGuardUnavailableError, guardPaneFocusForAgentInput } from './agent-input-focus-guard'
import {
  BrowserAgentActivity,
  type AgentCommandLease,
  type AgentPointerInput
} from './browser-agent-activity'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  private readonly capturePaintHolds = new Map<Electron.WebContents, Map<string, number>>()
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

  /** The page shows "An agent is using this page": a command is queued or one settled within the idle window. */
  isAgentUsingPage(browserPageId: string): boolean {
    return this.agentActivity.isActive(browserPageId)
  }

  // Show the agent's pointer landing before the input it precedes reaches the page.
  showAgentPointer(guest: Electron.WebContents, input: AgentPointerInput): Promise<void> {
    return this.agentActivity.showPointer(guest, input)
  }

  // Non-capture commands only need the guest itself unthrottled; host paint stays parked.
  holdGuestActive(guestWebContentsId: number): () => void {
    const guest = webContents.fromId(guestWebContentsId)
    return guest && !guest.isDestroyed() ? rendererPublicationThrottle.acquire(guest) : () => {}
  }

  // Do not await the renderer: minimized or throttled windows must not stall frame capture.
  holdPaintForCapture(guestWebContentsId: number): () => void {
    const releaseGuestThrottle = this.holdGuestActive(guestWebContentsId)
    const browserPageId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    const renderer = browserPageId ? this.resolveRendererForBrowserTab(browserPageId) : null
    if (!browserPageId || !renderer || renderer.isDestroyed()) {
      return releaseGuestThrottle
    }
    let pageHolds = this.capturePaintHolds.get(renderer)
    if (!pageHolds) {
      pageHolds = new Map()
      this.capturePaintHolds.set(renderer, pageHolds)
    }
    const holds = pageHolds.get(browserPageId) ?? 0
    pageHolds.set(browserPageId, holds + 1)
    if (holds === 0) {
      sendPaintHold(renderer, browserPageId, true)
    }
    let releaseThrottle = (): void => {}
    let released = false
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      const remaining = (pageHolds.get(browserPageId) ?? 1) - 1
      if (remaining > 0) {
        pageHolds.set(browserPageId, remaining)
      } else {
        pageHolds.delete(browserPageId)
        if (pageHolds.size === 0) {
          this.capturePaintHolds.delete(renderer)
        }
        sendPaintHold(renderer, browserPageId, false)
      }
      releaseThrottle()
      releaseGuestThrottle()
    }
    try {
      // Lift throttling so capture retries do not wait on delayed parking changes.
      releaseThrottle = rendererPublicationThrottle.acquire(renderer)
    } catch (error) {
      release()
      throw error
    }
    return release
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

// A paint hint must not fail the capture or command it accompanies; disposed frames throw.
function sendPaintHold(renderer: Electron.WebContents, browserPageId: string, held: boolean): void {
  if (renderer.isDestroyed()) {
    return
  }
  try {
    renderer.send('browser:capturePaintHold', { browserPageId, held })
  } catch {}
}
