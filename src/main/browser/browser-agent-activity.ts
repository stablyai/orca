import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { isResourceWindowVisible } from '../window/resource-view-admission'
import { sendGuestCdpCommand } from './guest-cdp-command'
import { isAgentRpcCaller } from '../runtime/rpc/rpc-caller-identity'
import {
  BROWSER_AGENT_ACTIVITY_CHANNEL,
  BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL,
  BROWSER_AGENT_CURSOR_CHANNEL,
  type BrowserAgentActivityEvent,
  type BrowserAgentCursorEvent
} from '../../shared/browser-agent-activity-contract'
import { getActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'

// Spans an agent's thinking between steps; a finished, failed or disconnected agent clears within it.
const ACTIVITY_IDLE_MS = 20_000
const CURSOR_ARRIVAL_TIMEOUT_MS = 1500

/** A CDP mouse event's params, as the agent sent them. */
export type AgentPointerInput = {
  type?: unknown
  x?: unknown
  y?: unknown
  buttons?: unknown
}

type PageActivity = {
  /** Agent commands queued or running; the tab stays marked while any remain. */
  commands: number
  /** An agent command is running now; only its pointer input shows the cursor. */
  executing: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** One page-targeted command, held from when it is queued until it settles. */
export type AgentCommandLease = {
  /** The command came from an agent's CLI, not a person's relayed input. */
  agent: boolean
  run: <T>(execute: () => Promise<T>) => Promise<T>
  end: () => void
}

type PendingArrival = {
  browserPageId: string
  rendererId: number
  timer: ReturnType<typeof setTimeout>
  resolve: () => void
}

type BrowserAgentActivityDeps = {
  pageIdForGuest: (guestWebContentsId: number) => string | null
  rendererForPage: (browserPageId: string) => WebContents | null
  worktreeForPage: (browserPageId: string) => string | null
}

const NOT_AN_AGENT: AgentCommandLease = {
  agent: false,
  run: (execute) => execute(),
  end: () => {}
}

/** Which pages an agent drives, and the show-before-act handshake for its pointer. */
export class BrowserAgentActivity {
  private readonly pages = new Map<string, PageActivity>()
  private readonly pendingArrivals = new Map<number, PendingArrival>()
  private sequence = 0
  private listening = false

  constructor(private readonly deps: BrowserAgentActivityDeps) {}

  /** Marks the page as agent-driven for one command; people's relayed input never counts. */
  beginCommand(browserPageId: string): AgentCommandLease {
    if (!isAgentRpcCaller(getActiveRpcCaller())) {
      return NOT_AN_AGENT
    }
    let page = this.pages.get(browserPageId)
    if (!page) {
      page = { commands: 0, executing: false, idleTimer: null }
      this.pages.set(browserPageId, page)
    }
    // Every command republishes, so a reloaded or newly attached window catches up.
    this.publish(browserPageId, true)
    if (page.idleTimer) {
      clearTimeout(page.idleTimer)
      page.idleTimer = null
    }
    page.commands += 1
    const owned = page
    let ended = false
    const end = (): void => {
      if (ended || this.pages.get(browserPageId) !== owned) {
        return
      }
      ended = true
      owned.commands -= 1
      if (owned.commands === 0) {
        this.restartIdleWindow(browserPageId, owned)
      }
    }
    return {
      agent: true,
      run: async (execute) => {
        owned.executing = true
        try {
          return await execute()
        } finally {
          // Settles before the page queue starts its next command, which may be a person's input.
          owned.executing = false
          end()
        }
      },
      end
    }
  }

  /** The agent continues on another page (a closed popup's opener), so its claim moves there. */
  handOver(fromPageId: string, toPageId: string): void {
    const existing = this.pages.get(toPageId)
    // A running command restarts the idle window itself when it settles.
    if (!this.pages.has(fromPageId) || (existing && existing.commands > 0)) {
      return
    }
    const page = existing ?? { commands: 0, executing: false, idleTimer: null }
    this.restartIdleWindow(toPageId, page)
    if (!existing) {
      this.pages.set(toPageId, page)
      this.publish(toPageId, true)
    }
  }

  private restartIdleWindow(browserPageId: string, page: PageActivity): void {
    if (page.idleTimer) {
      clearTimeout(page.idleTimer)
    }
    page.idleTimer = setTimeout(() => this.end(browserPageId), ACTIVITY_IDLE_MS)
  }

  isActive(browserPageId: string): boolean {
    return this.pages.has(browserPageId)
  }

  end(browserPageId: string): void {
    const page = this.pages.get(browserPageId)
    if (!page) {
      return
    }
    if (page.idleTimer) {
      clearTimeout(page.idleTimer)
    }
    this.pages.delete(browserPageId)
    for (const [sequence, pending] of this.pendingArrivals) {
      if (pending.browserPageId === browserPageId) {
        this.settleArrival(sequence)
      }
    }
    this.publish(browserPageId, false)
  }

  /** Moves the page's agent cursor to an input's point; resolves once it has visibly landed. */
  async showPointer(guest: WebContents, input: AgentPointerInput): Promise<void> {
    const press = input.type === 'mousePressed'
    const { x, y } = input
    if ((input.type !== 'mouseMoved' && !press) || !isFiniteNumber(x) || !isFiniteNumber(y)) {
      return
    }
    const browserPageId = this.deps.pageIdForGuest(guest.id)
    if (!browserPageId || !this.pages.get(browserPageId)?.executing) {
      return
    }
    const renderer = this.deps.rendererForPage(browserPageId)
    if (!renderer || renderer.isDestroyed()) {
      return
    }
    const viewport = await readPageViewport(guest)
    if (!viewport || renderer.isDestroyed()) {
      return
    }
    // Drag steps and the press after a move follow without waiting; only a fresh move is shown first.
    const watchable = isResourceWindowVisible(BrowserWindow.fromWebContents(renderer))
    const awaitsArrival = watchable && !press && !input.buttons
    const sequence = ++this.sequence
    const event: BrowserAgentCursorEvent = {
      browserPageId,
      sequence,
      x,
      y,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      press,
      awaitsArrival
    }
    if (!awaitsArrival) {
      renderer.send(BROWSER_AGENT_CURSOR_CHANNEL, event)
      return
    }
    this.listenForArrivals()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => this.settleArrival(sequence), CURSOR_ARRIVAL_TIMEOUT_MS)
      this.pendingArrivals.set(sequence, { browserPageId, rendererId: renderer.id, timer, resolve })
      renderer.send(BROWSER_AGENT_CURSOR_CHANNEL, event)
    })
  }

  private settleArrival(sequence: number): void {
    const pending = this.pendingArrivals.get(sequence)
    if (!pending) {
      return
    }
    this.pendingArrivals.delete(sequence)
    clearTimeout(pending.timer)
    pending.resolve()
  }

  private listenForArrivals(): void {
    if (this.listening) {
      return
    }
    this.listening = true
    ipcMain.on(BROWSER_AGENT_CURSOR_ARRIVED_CHANNEL, (event, reply: unknown) => {
      const sequence =
        reply !== null && typeof reply === 'object' && 'sequence' in reply ? reply.sequence : null
      if (typeof sequence !== 'number') {
        return
      }
      if (this.pendingArrivals.get(sequence)?.rendererId === event.sender.id) {
        this.settleArrival(sequence)
      }
    })
  }

  private publish(browserPageId: string, active: boolean): void {
    const renderer = this.deps.rendererForPage(browserPageId)
    if (renderer && !renderer.isDestroyed()) {
      const event: BrowserAgentActivityEvent = {
        browserPageId,
        worktreeId: this.deps.worktreeForPage(browserPageId),
        active
      }
      renderer.send(BROWSER_AGENT_ACTIVITY_CHANNEL, event)
    }
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// Input points are in the page's CSS px; innerWidth/innerHeight include classic scrollbars,
// matching the webview box the renderer scales against, where clientWidth would not.
async function readPageViewport(
  guest: WebContents
): Promise<{ width: number; height: number } | null> {
  try {
    const response: unknown = await sendGuestCdpCommand(guest, 'Runtime.evaluate', {
      expression: '[innerWidth, innerHeight]',
      returnByValue: true
    })
    const result =
      response !== null && typeof response === 'object' && 'result' in response
        ? response.result
        : null
    const size =
      result !== null && typeof result === 'object' && 'value' in result ? result.value : null
    if (Array.isArray(size) && isPositiveNumber(size[0]) && isPositiveNumber(size[1])) {
      return { width: size[0], height: size[1] }
    }
  } catch {
    // A page that cannot report its viewport just shows no cursor.
  }
  return null
}

function isPositiveNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0
}
