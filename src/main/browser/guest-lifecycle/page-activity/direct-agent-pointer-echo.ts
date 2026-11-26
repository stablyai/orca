import { BrowserWindow, type WebContents } from 'electron'
import { isResourceWindowVisible } from '../../../window/visibility/resource-view-admission'
import { isFiniteNumber, readPageViewport } from './agent-page-viewport'
import {
  BROWSER_AGENT_CURSOR_CHANNEL,
  type BrowserAgentCursorEvent
} from '../../../../shared/browser/automation/browser-agent-activity-contract'
import type { AgentPointerInput } from './browser-agent-activity'

/** One move per frame reaches the overlay; a press always does, so its pulse shows. */
export const DIRECT_POINTER_FRAME_MS = 16
/** The page's viewport is reread off the input path at most this often. */
const VIEWPORT_TTL_MS = 1000

/** A page a direct client drives: it runs no Orca commands and names no chat or SSH host. */
export function directClientPageActivity(): {
  commands: number
  executing: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  controller: null
  agentSessionId: undefined
} {
  return {
    commands: 0,
    executing: false,
    idleTimer: null,
    controller: null,
    agentSessionId: undefined
  }
}

type Point = { x: number; y: number; press: boolean }
type Viewport = { width: number; height: number; readAt: number }
type PageEcho = {
  guest: WebContents
  pending: Point | null
  frame: ReturnType<typeof setTimeout> | null
}

type DirectAgentPointerEchoDeps = {
  pageIdForGuest: (guestWebContentsId: number) => string | null
  rendererForPage: (browserPageId: string) => WebContents | null
  /** The page is driven by a direct client; keeps its agent mark lit through the idle window. */
  markActive: (browserPageId: string) => void
  readViewport?: (guest: WebContents) => Promise<{ width: number; height: number } | null>
  isWindowVisible?: (renderer: WebContents) => boolean
}

/**
 * Draws an `orca tab cdp` client's pointer after its input was sent, never holding the input:
 * no arrival handshake and no page read on the input path.
 */
export class DirectAgentPointerEcho {
  private readonly pages = new Map<string, PageEcho>()
  private readonly viewports = new WeakMap<WebContents, Viewport>()
  private readonly refreshing = new WeakSet<WebContents>()
  // Negative, so they never match a sequence Orca's helper waits on for an arrival.
  private sequence = 0

  constructor(private readonly deps: DirectAgentPointerEchoDeps) {}

  echo(guest: WebContents, input: AgentPointerInput): void {
    const press = input.type === 'mousePressed'
    if ((input.type !== 'mouseMoved' && !press) || !isFiniteNumber(input.x)) {
      return
    }
    if (!isFiniteNumber(input.y)) {
      return
    }
    const browserPageId = this.deps.pageIdForGuest(guest.id)
    if (!browserPageId) {
      return
    }
    this.deps.markActive(browserPageId)
    let page = this.pages.get(browserPageId)
    if (!page) {
      page = { guest, pending: null, frame: null }
      this.pages.set(browserPageId, page)
    }
    page.guest = guest
    page.pending = { x: input.x, y: input.y, press }
    // A move inside the current frame waits for its end; the latest one wins.
    if (!press && page.frame) {
      return
    }
    this.flush(browserPageId, page)
  }

  private flush(browserPageId: string, page: PageEcho): void {
    const point = page.pending
    if (!point) {
      return
    }
    const viewport = this.viewport(page.guest, browserPageId)
    if (!viewport) {
      // The first read is under way; it flushes the latest point when it lands.
      return
    }
    page.pending = null
    this.send(browserPageId, point, viewport)
    if (page.frame) {
      clearTimeout(page.frame)
    }
    page.frame = setTimeout(() => {
      page.frame = null
      if (page.pending) {
        this.flush(browserPageId, page)
      } else if (this.pages.get(browserPageId) === page) {
        this.pages.delete(browserPageId)
      }
    }, DIRECT_POINTER_FRAME_MS)
  }

  private viewport(guest: WebContents, browserPageId: string): Viewport | null {
    const cached = this.viewports.get(guest)
    if (!cached || Date.now() - cached.readAt >= VIEWPORT_TTL_MS) {
      this.refreshViewport(guest, browserPageId)
    }
    return cached ?? null
  }

  private refreshViewport(guest: WebContents, browserPageId: string): void {
    if (this.refreshing.has(guest)) {
      return
    }
    this.refreshing.add(guest)
    const read = this.deps.readViewport ?? readPageViewport
    void read(guest)
      .then((size) => {
        if (!size) {
          return
        }
        const first = !this.viewports.has(guest)
        this.viewports.set(guest, { ...size, readAt: Date.now() })
        const page = this.pages.get(browserPageId)
        if (first && page) {
          this.flush(browserPageId, page)
        }
      })
      .finally(() => this.refreshing.delete(guest))
  }

  private send(browserPageId: string, point: Point, viewport: Viewport): void {
    const renderer = this.deps.rendererForPage(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return
    }
    const visible =
      this.deps.isWindowVisible ??
      ((contents: WebContents) => isResourceWindowVisible(BrowserWindow.fromWebContents(contents)))
    if (!visible(renderer)) {
      return
    }
    const event: BrowserAgentCursorEvent = {
      ...point,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      browserPageId,
      sequence: --this.sequence,
      awaitsArrival: false
    }
    renderer.send(BROWSER_AGENT_CURSOR_CHANNEL, event)
  }
}
