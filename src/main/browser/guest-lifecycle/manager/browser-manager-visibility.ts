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
import { printForBrowserViewer } from '../prompts/browser-print-viewers'

export abstract class BrowserManagerVisibility extends BrowserManagerState {
  protected readonly capturePaintHolds = new Map<Electron.WebContents, Map<string, number>>()
  protected readonly agentActivity = new BrowserAgentActivity({
    pageIdForGuest: (guestWebContentsId) =>
      this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId),
    rendererForPage: (browserPageId) => this.resolveRendererForBrowserTab(browserPageId),
    worktreeForPage: (browserPageId) => this.worktreeIdByTabId.get(browserPageId) ?? null,
    // A server page's row carries the agent mark to viewers on other machines.
    onPageActiveChanged: (browserPageId) => {
      const guestId =
        this.webContentsIdByTabId.get(browserPageId) ?? browserPopupPageWebContentsId(browserPageId)
      if (guestId !== null) {
        this.notifyBrowserGuestStateChanged(guestId)
      }
    }
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
    if (!lease.agent) {
      return lease
    }
    this.leadAgentOnPage(browserPageId)
    return {
      ...lease,
      // A person's input queued ahead may have taken the page back; the agent leads again as it acts,
      // and what the page does from here (a timed print, a popup) is not that input's.
      run: (execute) =>
        lease.run(() => {
          this.leadAgentOnPage(browserPageId)
          this.withdrawPageInputCredit(browserPageId)
          return execute()
        })
    }
  }

  private withdrawPageInputCredit(browserPageId: string): void {
    const pageGuestId =
      this.webContentsIdByTabId.get(browserPageId) ?? browserPopupPageWebContentsId(browserPageId)
    const ownerTabId =
      pageGuestId === null ? null : this.resolveBrowserTabIdForGuestWebContentsId(pageGuestId)
    this.pageInputCredit.withdraw(ownerTabId ?? browserPageId)
  }

  private leadAgentOnPage(browserPageId: string): void {
    const pageGuestId =
      this.webContentsIdByTabId.get(browserPageId) ?? browserPopupPageWebContentsId(browserPageId)
    // An SSH route popup has no guest policies, so its opener carries the lead.
    const guestId =
      pageGuestId === null
        ? null
        : (resolveBrowserRouteGuestPopupOpener(pageGuestId) ?? pageGuestId)
    // Only attached guests, whose teardown releases the lead.
    if (guestId !== null && this.policyAttachedGuestIds.has(guestId)) {
      this.leadAgent(guestId)
    }
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

  /** A person's own input takes the page back from the agent. */
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

  /** Input injected into this guest's page now is a person's: a paired viewer's relayed click or key press. */
  isPersonCommandRunning(guestWebContentsId: number): boolean {
    return this.pageInputCredit.isRunningPersonCommand(this.pageIdForGuest(guestWebContentsId))
  }

  /** Credits a guest's activating input (or a DOM-activated tap) to the command delivering it, under the tab a link it opens would join. */
  creditPageInput(guestWebContentsId: number): void {
    if (this.pageInputCredit.idle) {
      return
    }
    // A viewer's click or tap arrives injected, like an agent's, but is the person's own input.
    if (this.isPersonCommandRunning(guestWebContentsId)) {
      this.releaseAgentLead(
        resolveBrowserRouteGuestPopupOpener(guestWebContentsId) ?? guestWebContentsId
      )
    }
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    if (ownerTabId) {
      this.pageInputCredit.creditInput(ownerTabId, this.pageIdForGuest(guestWebContentsId))
    }
  }

  /** An agent drove the page this guest shows since a person last gave it input. */
  isAgentLedGuest(guestWebContentsId: number): boolean {
    // SSH route popups skip guest policies, so they follow their opener's lead.
    return this.agentLedGuestIds.has(
      resolveBrowserRouteGuestPopupOpener(guestWebContentsId) ?? guestWebContentsId
    )
  }

  /** An agent drives the page this guest shows (a tab or a popup), or drove it since a person last gave it input. */
  isAgentLeadingGuest(guestWebContentsId: number): boolean {
    return (
      this.isAgentLedGuest(guestWebContentsId) ||
      this.isAgentUsingPage(this.pageIdForGuest(guestWebContentsId))
    )
  }

  /** An offscreen page, or a popup one opened: viewers list both as server tabs. */
  abstract isListedAsServerPage(guestWebContentsId: number): boolean

  /**
   * A page's print() opened no dialog here. On a server page, the device whose own input just
   * reached it saves it as a PDF; otherwise, the agent leading the page is told, as its dialog
   * would take the foreground.
   */
  reportHeldPrint(
    guestWebContentsId: number,
    frame: Electron.WebFrameMain | null,
    origin: string
  ): void {
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(guestWebContentsId)
    // Viewer input waits behind a running agent command, so a print during one is the agent's.
    const pairedDeviceId =
      ownerTabId &&
      frame &&
      this.isListedAsServerPage(guestWebContentsId) &&
      !this.isAgentCommandRunning(guestWebContentsId)
        ? this.pageInputCredit.peek(ownerTabId)
        : null
    if (pairedDeviceId && frame) {
      const title = webContents.fromId(guestWebContentsId)?.getTitle() ?? ''
      if (printForBrowserViewer(guestWebContentsId, frame, pairedDeviceId, title)) {
        return
      }
    }
    if (!this.isAgentLedGuest(guestWebContentsId)) {
      return
    }
    // Reach a command on the popup page itself as well as one on the tab that owns it.
    const pageIds = new Set([this.pageIdForGuest(guestWebContentsId), ownerTabId])
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

  protected isAgentCommandRunning(guestWebContentsId: number): boolean {
    return this.agentActivity.isExecuting(this.pageIdForGuest(guestWebContentsId))
  }

  /** The page shows "An agent is using this page": a command is queued or one settled within the idle window. */
  isAgentUsingPage(browserPageId: string): boolean {
    return this.agentActivity.isActive(browserPageId)
  }

  /** A stream viewer draws the agent's pointer on the page until the returned stop runs. */
  watchAgentCursor(
    browserPageId: string,
    listener: Parameters<BrowserAgentActivity['watchCursor']>[1]
  ): () => void {
    return this.agentActivity.watchCursor(browserPageId, listener)
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
    if (!browserPageId) {
      return Promise.reject(focusGuardUnavailableError('missing_page'))
    }
    const renderer = this.resolveRendererForBrowserTab(browserPageId)
    if (!renderer) {
      return Promise.reject(focusGuardUnavailableError('missing_renderer'))
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
