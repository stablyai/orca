import { webContents } from 'electron'
import { rendererPublicationThrottle } from '../../../window/visibility/renderer-publication-throttle'
import { BrowserManagerState } from './browser-manager-state'
import {
  focusGuardUnavailableError,
  guardPaneFocusForAgentInput
} from '../../cdp/input/agent-input-focus-guard'
import {
  BrowserAgentActivity,
  type AgentCommandLease,
  type AgentPointerInput
} from '../page-activity/browser-agent-activity'
import { BrowserPageEvents, type BrowserPageEvent } from '../page-activity/browser-page-events'
import { BrowserPageInputCredit } from '../../routing/input-ownership/browser-page-input-credit'
import { browserPopupPageId, browserPopupPageWebContentsId } from '../popups/browser-popup-page-id'
import { resolveBrowserRouteGuestPopupOpener } from '../../routing/guest-authority/browser-route-guest-popup-ownership'
import type { RpcCallerIdentity } from '../../../runtime/rpc/callers/rpc-caller-identity'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  private readonly capturePaintHolds = new Map<Electron.WebContents, Map<string, number>>()
  protected readonly agentActivity = new BrowserAgentActivity({
    pageIdForGuest: (guestWebContentsId) =>
      this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId),
    rendererForPage: (browserPageId) => this.resolveRendererForBrowserTab(browserPageId),
    worktreeForPage: (browserPageId) => this.worktreeIdByTabId.get(browserPageId) ?? null
  })

  private agentLeadListener: ((guestWebContentsId: number, led: boolean) => void) | null = null

  protected readonly pageEvents = new BrowserPageEvents()
  protected readonly pageInputCredit = new BrowserPageInputCredit()

  /** Tabs requested, popup outcomes and downloads attributed to the page, as they happen. */
  observePageEvents(
    browserPageId: string,
    listener: (event: BrowserPageEvent) => void
  ): () => void {
    return this.pageEvents.observe(browserPageId, listener)
  }

  /** Holds the page's agent marking for one queued command, from queueing until it settles. */
  beginAgentCommand(browserPageId: string): AgentCommandLease {
    const lease = this.agentActivity.beginCommand(browserPageId)
    const pageGuestId =
      this.webContentsIdByTabId.get(browserPageId) ?? browserPopupPageWebContentsId(browserPageId)
    // An SSH route popup has no guest policies, so its opener carries the lead.
    const guestId =
      pageGuestId === null
        ? null
        : (resolveBrowserRouteGuestPopupOpener(pageGuestId) ?? pageGuestId)
    // Only attached guests, whose teardown releases the lead.
    if (lease.agent && guestId !== null && this.policyAttachedGuestIds.has(guestId)) {
      this.leadAgent(guestId)
    }
    return lease
  }

  /** Tells the page's frames when the agent takes or gives up its lead, so they can refuse system dialogs. */
  setAgentLeadListener(
    listener: ((guestWebContentsId: number, led: boolean) => void) | null
  ): void {
    this.agentLeadListener = listener
  }

  private leadAgent(guestWebContentsId: number): void {
    if (!this.agentLedGuestIds.has(guestWebContentsId)) {
      this.agentLedGuestIds.add(guestWebContentsId)
      this.agentLeadListener?.(guestWebContentsId, true)
    }
  }

  /** A popup opened from a page the agent leads starts led too. */
  protected inheritAgentLead(openerWebContentsId: number, popupWebContentsId: number): void {
    if (
      this.agentLedGuestIds.has(openerWebContentsId) &&
      this.policyAttachedGuestIds.has(popupWebContentsId)
    ) {
      this.leadAgent(popupWebContentsId)
    }
  }

  /** The desktop user's own input takes the page back from the agent. */
  releaseAgentLead(guestWebContentsId: number): void {
    if (this.agentLedGuestIds.delete(guestWebContentsId)) {
      this.agentLeadListener?.(guestWebContentsId, false)
    }
  }

  /** Clears the agent marking from every page this SSH host was driving. */
  endAgentCommandsFromHost(targetId: string): void {
    this.agentActivity.endForController(targetId)
  }

  /** Runs one queued page command so input it delivers is credited to its caller. */
  runPageCommand<T>(
    browserPageId: string,
    caller: RpcCallerIdentity | undefined,
    execute: () => Promise<T>
  ): Promise<T> {
    return this.pageInputCredit.during(browserPageId, caller, execute)
  }

  /** Credits a guest's activating input (or a DOM-activated tap) to the command delivering it, under the tab a link it opens would join. */
  creditPageInput(guestWebContentsId: number): void {
    if (this.pageInputCredit.idle) {
      return
    }
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (ownerTabId) {
      this.pageInputCredit.creditInput(ownerTabId, this.pageIdForGuest(guestWebContentsId))
    }
  }

  /** An agent drove the page this guest shows since the desktop user last gave it input. */
  isAgentLedGuest(guestWebContentsId: number): boolean {
    // SSH route popups skip guest policies, so they follow their opener's lead.
    return this.agentLedGuestIds.has(
      resolveBrowserRouteGuestPopupOpener(guestWebContentsId) ?? guestWebContentsId
    )
  }

  /** An agent drives the page this guest shows (a tab or a popup), or drove it since the desktop user last gave it input. */
  isAgentLeadingGuest(guestWebContentsId: number): boolean {
    return (
      this.isAgentLedGuest(guestWebContentsId) ||
      this.isAgentUsingPage(this.pageIdForGuest(guestWebContentsId))
    )
  }

  /** A page the agent leads refused its own print dialog, which would take the foreground; tell the agent. */
  reportRefusedPrint(guestWebContentsId: number, origin: string): void {
    if (!this.isAgentLedGuest(guestWebContentsId)) {
      return
    }
    // Reach a command on the popup page itself as well as one on the tab that owns it.
    const pageIds = new Set([
      this.pageIdForGuest(guestWebContentsId),
      this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    ])
    for (const pageId of pageIds) {
      if (pageId) {
        this.pageEvents.emit(pageId, { kind: 'print', origin })
      }
    }
  }

  private pageIdForGuest(guestWebContentsId: number): string {
    return (
      this.tabIdByWebContentsId.get(guestWebContentsId) ?? browserPopupPageId(guestWebContentsId)
    )
  }

  handOverAgentActivity(fromPageId: string, toPageId: string): void {
    this.agentActivity.handOver(fromPageId, toPageId)
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
