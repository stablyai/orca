import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { BrowserError } from '../browser-error'
import type { BrowserManager } from '../browser-manager'
import type { BrowserPopupPage } from '../browser-manager-types'
import { createAgentBrowserProcessEnvironment } from './agent-browser-process-environment'
import { resolveAgentBrowserBinary } from './agent-browser-bridge-process'
import type {
  AgentBrowserBridgeOptions,
  QueuedCommand,
  SessionState
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeState {
  // Isolate each worktree's tab selection.
  protected readonly activeWebContentsPerWorktree = new Map<string, number>()
  protected activeWebContentsId: number | null = null
  // A person's tab pick waiting for the agent's tab to go idle; the undefined key is the global target.
  protected readonly heldPersonSelections = new Map<string | undefined, number>()
  // Each page has its own ref map; a worktree's unpinned refs belong to the page that last minted refs.
  protected readonly refPageByWorktree = new Map<string | undefined, string>()
  protected readonly watchedPopupWebContentsIds = new Set<number>()
  protected readonly sessions = new Map<string, SessionState>()
  protected readonly commandQueues = new Map<string, QueuedCommand[]>()
  protected readonly processingQueues = new Set<string>()
  protected readonly agentBrowserBin: string
  protected readonly agentBrowserEnv: NodeJS.ProcessEnv
  protected readonly ownsAgentBrowserSocketDirectory: boolean
  // Null disables idle-replacement detection when daemon lifetime is unbounded.
  protected readonly agentBrowserIdleTimeoutMs: number | null
  // Restore routes after a process swap destroys the session.
  protected readonly pendingInterceptRestore = new Map<string, string[]>()
  protected readonly pendingSessionCreation = new Map<string, Promise<void>>()
  // Await the old close before reusing its session name, or it can close the replacement.
  protected readonly pendingSessionDestruction = new Map<string, Promise<void>>()
  protected readonly cancelledProcesses = new WeakSet<ChildProcess>()
  protected shutdownStarted = false

  constructor(
    protected readonly browserManager: BrowserManager,
    protected readonly options: AgentBrowserBridgeOptions = {}
  ) {
    this.agentBrowserBin = resolveAgentBrowserBinary()
    const processEnvironment = createAgentBrowserProcessEnvironment({
      inheritedEnv: process.env,
      platform: process.platform,
      userDataPath: app.getPath('userData')
    })
    this.agentBrowserEnv = processEnvironment.env
    this.ownsAgentBrowserSocketDirectory = processEnvironment.ownsSocketDirectory
    const idleTimeoutMs = Number(this.agentBrowserEnv.AGENT_BROWSER_IDLE_TIMEOUT_MS)
    this.agentBrowserIdleTimeoutMs = idleTimeoutMs > 0 ? idleTimeoutMs : null
  }

  protected recordRefPage(browserPageId: string): void {
    this.refPageByWorktree.set(
      this.browserManager.getWorktreeIdForTab(browserPageId),
      browserPageId
    )
  }

  // Refs are numbered per page, so another page's ref would silently match an element here.
  protected assertRefsFromPage(
    browserPageId: string,
    elements: readonly (string | undefined)[]
  ): void {
    const ref = elements.find((element) => element !== undefined && isSnapshotRef(element))
    if (!ref) {
      return
    }
    const snapshotPageId = this.refPageByWorktree.get(
      this.browserManager.getWorktreeIdForTab(browserPageId)
    )
    if (!snapshotPageId || snapshotPageId === browserPageId) {
      return
    }
    // The latest snapshot may have been a pinned look elsewhere, so the snapshot hint comes first.
    const pinnedRetry = this.browserManager.getWebContentsIdByTabId().has(snapshotPageId)
      ? `, or pass --page ${snapshotPageId} if ${ref} came from that page's snapshot`
      : ''
    throw new BrowserError(
      'browser_stale_ref',
      `The latest snapshot was of page ${snapshotPageId}, not the current tab (page ${browserPageId}), so ${ref} may point at the wrong element. Run snapshot to get refs for page ${browserPageId}${pinnedRetry}.`
    )
  }

  protected resolveTabIdSafe(webContentsId: number): string | null {
    return (
      this.browserManager.getTabIdForWebContentsId(webContentsId) ??
      this.findPopupPage(webContentsId)?.browserPageId ??
      null
    )
  }

  protected findPopupPage(webContentsId: number): BrowserPopupPage | undefined {
    return this.browserManager
      .getPopupPages()
      .find((popup) => popup.webContentsId === webContentsId)
  }

  // The daemon exits after this much idle time, taking its routes and delta baseline.
  protected isDaemonIdledOut(session: SessionState): boolean {
    return (
      this.agentBrowserIdleTimeoutMs !== null &&
      Date.now() - session.lastCommandAt >= this.agentBrowserIdleTimeoutMs
    )
  }

  protected getWebContents(webContentsId: number): Electron.WebContents | null {
    try {
      const { webContents } = require('electron')
      const target = webContents.fromId(webContentsId)
      return target && !target.isDestroyed() ? target : null
    } catch {
      return null
    }
  }

  protected registeredTabsWithoutPopups(worktreeId?: string): Map<string, number> {
    const tabs = new Map<string, number>()
    for (const [tabId, wcId] of this.browserManager.getWebContentsIdByTabId()) {
      if (!worktreeId || this.browserManager.getWorktreeIdForTab(tabId) === worktreeId) {
        tabs.set(tabId, wcId)
      }
    }
    return tabs
  }

  /** Moves every route at one webContents to another; true when the agent's route moved. */
  protected retargetRouting(fromWebContentsId: number, toWebContentsId: number): boolean {
    let moved = false
    if (this.activeWebContentsId === fromWebContentsId) {
      this.activeWebContentsId = toWebContentsId
      moved = true
    }
    for (const [worktreeId, routedWebContentsId] of this.activeWebContentsPerWorktree) {
      if (routedWebContentsId === fromWebContentsId) {
        this.activeWebContentsPerWorktree.set(worktreeId, toWebContentsId)
        moved = true
      }
    }
    for (const [key, heldWebContentsId] of this.heldPersonSelections) {
      if (heldWebContentsId === fromWebContentsId) {
        this.heldPersonSelections.set(key, toWebContentsId)
      }
    }
    return moved
  }
}

// agent-browser reads `@e3`, `ref=e3` and bare `e3` as snapshot refs.
function isSnapshotRef(element: string): boolean {
  return /^(?:@|ref=)?e\d+$/.test(element)
}
