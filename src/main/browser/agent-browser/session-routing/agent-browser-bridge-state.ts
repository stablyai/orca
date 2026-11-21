import { app } from 'electron'
import type { ChildProcess } from 'node:child_process'
import { BrowserError } from '../../browser-error'
import type { BrowserManager } from '../../guest-lifecycle/manager/browser-manager'
import type { BrowserPopupPage } from '../../guest-lifecycle/popups/browser-popup-ownership'
import {
  createAgentBrowserProcessEnvironment,
  pointAtEmptyAgentBrowserConfig
} from '../helper-process/agent-browser-process-environment'
import { resolveAgentBrowserBinary } from '../helper-process/agent-browser-binary'
import type { QueuedCommand } from '../command-queue/agent-browser-queued-command'
import type { SessionState } from '../session-lifecycle/agent-browser-session-state'

export abstract class AgentBrowserBridgeState {
  // Routes hold page IDs, so a page freed while hidden stays the target and restores on use.
  protected readonly routedPagePerWorktree = new Map<string, string>()
  protected routedPageId: string | null = null
  // A person's tab pick waiting for the agent's tab to go idle; the undefined key is the global target.
  protected readonly heldPersonSelections = new Map<string | undefined, string>()
  private readonly routingReferencesByPage = new Map<
    string,
    { routes: Set<string>; held: Set<string | undefined> }
  >()
  // Each page has its own ref map; a worktree's unpinned refs belong to the page that last minted refs.
  protected readonly refPageByWorktree = new Map<string | undefined, string>()
  protected readonly watchedPopupWebContentsIds = new Set<number>()
  protected readonly sessions = new Map<string, SessionState>()
  protected readonly commandQueues = new Map<string, QueuedCommand[]>()
  protected readonly processingQueues = new Set<string>()
  protected readonly agentBrowserBin: string
  protected readonly agentBrowserEnv: NodeJS.ProcessEnv
  // Startup spawns await it; agent commands come long after it lands.
  protected readonly agentBrowserConfigReady: Promise<void>
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
    const userDataPath = app.getPath('userData')
    const processEnvironment = createAgentBrowserProcessEnvironment({
      inheritedEnv: process.env,
      platform: process.platform,
      userDataPath
    })
    this.agentBrowserEnv = processEnvironment.env
    // A failed write keeps agent-browser's own lookup; a missing file would fail every command.
    this.agentBrowserConfigReady = pointAtEmptyAgentBrowserConfig(
      this.agentBrowserEnv,
      userDataPath
    ).catch(() => {})
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

  getRegisteredPageWebContentsId(browserPageId: string, worktreeId?: string): number | undefined {
    const tabs = this.browserManager.getWebContentsIdByTabId()
    const webContentsId = tabs.get(browserPageId)
    if (webContentsId !== undefined) {
      return !worktreeId || this.browserManager.getWorktreeIdForTab(browserPageId) === worktreeId
        ? webContentsId
        : undefined
    }
    const popup = this.browserManager
      .getPopupPages()
      .find((page) => page.browserPageId === browserPageId)
    return popup &&
      tabs.has(popup.openerBrowserPageId) &&
      (!worktreeId ||
        this.browserManager.getWorktreeIdForTab(popup.openerBrowserPageId) === worktreeId)
      ? popup.webContentsId
      : undefined
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

  protected setRoutedPageId(key: string | undefined, pageId: string | null): void {
    if (key === undefined) {
      this.routedPageId = pageId
      return
    }
    const previous = this.routedPagePerWorktree.get(key)
    if (previous === pageId || (previous === undefined && pageId === null)) {
      return
    }
    if (previous !== undefined) {
      const references = this.routingReferencesByPage.get(previous)
      references?.routes.delete(key)
      this.pruneRoutingReferences(previous)
    }
    if (pageId === null) {
      this.routedPagePerWorktree.delete(key)
    } else {
      this.routedPagePerWorktree.set(key, pageId)
      this.routingReferences(pageId).routes.add(key)
    }
  }

  protected setHeldPersonSelection(key: string | undefined, pageId: string | null): void {
    const previous = this.heldPersonSelections.get(key)
    if (previous === pageId || (previous === undefined && pageId === null)) {
      return
    }
    if (previous !== undefined) {
      const references = this.routingReferencesByPage.get(previous)
      references?.held.delete(key)
      this.pruneRoutingReferences(previous)
    }
    if (pageId === null) {
      this.heldPersonSelections.delete(key)
    } else {
      this.heldPersonSelections.set(key, pageId)
      this.routingReferences(pageId).held.add(key)
    }
  }

  private routingReferences(pageId: string): {
    routes: Set<string>
    held: Set<string | undefined>
  } {
    let references = this.routingReferencesByPage.get(pageId)
    if (!references) {
      references = { routes: new Set(), held: new Set() }
      this.routingReferencesByPage.set(pageId, references)
    }
    return references
  }

  private pruneRoutingReferences(pageId: string): void {
    const references = this.routingReferencesByPage.get(pageId)
    if (references && references.routes.size === 0 && references.held.size === 0) {
      this.routingReferencesByPage.delete(pageId)
    }
  }

  /** Moves every route at one page to another; true when the agent's route moved. */
  protected retargetRouting(fromPageId: string, toPageId: string | null): boolean {
    const references = this.routingReferencesByPage.get(fromPageId)
    const moved = this.routedPageId === fromPageId || (references?.routes.size ?? 0) > 0
    if (fromPageId === toPageId) {
      return moved
    }
    if (this.routedPageId === fromPageId) {
      this.setRoutedPageId(undefined, toPageId)
    }
    if (references) {
      for (const key of references.routes) {
        this.setRoutedPageId(key, toPageId)
      }
      for (const key of references.held) {
        this.setHeldPersonSelection(key, toPageId)
      }
    }
    return moved
  }
}

// agent-browser reads `@e3`, `ref=e3` and bare `e3` as snapshot refs.
function isSnapshotRef(element: string): boolean {
  return /^(?:@|ref=)?e\d+$/.test(element)
}

export type AgentBrowserBridgeOptions = {
  onTabsChanged?: (worktreeId?: string) => void
}
