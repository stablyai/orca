import { CdpWsProxy } from './cdp-ws-proxy'
import { BrowserError } from './cdp-bridge'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeRawProcess } from './agent-browser-bridge-raw-process'
import type { AgentBrowserCleanupOptions } from './agent-browser-bridge-types'
import { AGENT_BROWSER_CLEANUP_TIMEOUT_MS } from './agent-browser-bridge-types'
import { waitForAgentBrowserSessionExit } from './agent-browser-session-reset'
import { runOutsideRemoteCliBrowserScope } from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export abstract class AgentBrowserBridgeLifecycle extends AgentBrowserBridgeRawProcess {
  async onTabClosed(webContentsId: number): Promise<void> {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    const owningWorktreeId = browserPageId
      ? this.browserManager.getWorktreeIdForTab(browserPageId)
      : undefined
    let nextWorktreeActiveWebContentsId: number | null = null
    if (
      owningWorktreeId &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === webContentsId
    ) {
      nextWorktreeActiveWebContentsId = this.selectFallbackActiveWebContents(
        owningWorktreeId,
        webContentsId
      )
    }
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = nextWorktreeActiveWebContentsId
    }
    if (browserPageId) {
      await this.onPageClosed(browserPageId)
    }
    this.options.onTabsChanged?.(owningWorktreeId)
  }

  /** Offscreen backends unregister guests before cleanup, so close by page ID. */
  async onPageClosed(browserPageId: string): Promise<void> {
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    await this.destroySession(sessionName)
    this.pendingInterceptRestore.delete(sessionName)
  }

  async onProcessSwap(
    browserPageId: string,
    newWebContentsId: number,
    previousWebContentsId?: number
  ): Promise<void> {
    // Process swaps preserve page IDs but replace the guest and its session.
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    const session = this.sessions.get(sessionName)
    const oldWebContentsId = previousWebContentsId ?? session?.webContentsId
    const owningWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    if (session && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
    await this.destroySession(sessionName)
    if (oldWebContentsId != null) {
      this.retargetRouting(oldWebContentsId, newWebContentsId)
    }
    this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
  }
  // A closed popup ends its session and hands the agent back to its opener, not the first listed tab.
  protected watchPopupClose(webContentsId: number): void {
    if (this.watchedPopupWebContentsIds.has(webContentsId)) {
      return
    }
    const popup = this.findPopupPage(webContentsId)
    const contents = popup ? this.getWebContents(webContentsId) : null
    if (!popup || !contents) {
      return
    }
    this.watchedPopupWebContentsIds.add(webContentsId)
    contents.once('destroyed', () => {
      this.watchedPopupWebContentsIds.delete(webContentsId)
      const openerWebContentsId = this.browserManager.getGuestWebContentsId(
        popup.openerBrowserPageId
      )
      // A person's tab pick held while the agent drove the popup must keep waiting on the opener.
      if (
        openerWebContentsId !== null &&
        this.retargetRouting(webContentsId, openerWebContentsId)
      ) {
        this.browserManager.handOverAgentActivity(popup.browserPageId, popup.openerBrowserPageId)
      }
      const closeSession = (): void => void this.onPageClosed(popup.browserPageId)
      // The click that makes a popup close itself reports its own result, not a kill.
      const running = this.sessions.get(
        `${ORCA_TAB_SESSION_PREFIX}${popup.browserPageId}`
      )?.activeProcess
      if (running) {
        running.once('close', closeSession)
      } else {
        closeSession()
      }
    })
  }

  protected async ensureSession(
    sessionName: string,
    browserPageId: string,
    webContentsId: number
  ): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
    }
    this.assertCommandAdmission()

    const existing = this.sessions.get(sessionName)
    if (existing?.webContentsId === webContentsId) {
      return
    }
    if (existing) {
      // A renderer reload gives the page a new guest without a process-swap notice.
      await this.destroySession(sessionName, {
        closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS,
        keepQueuedCommands: true
      })
      this.assertCommandAdmission()
    }

    // Coalesce creation to avoid leaking duplicate proxies and debugger connections.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      this.assertCommandAdmission()
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${browserPageId} is no longer available`
        )
      }

      // Reset daemon sessions that may retain a CDP port from an earlier Orca process.
      await this.closeStaleAgentBrowserSession(sessionName)

      const proxy = new CdpWsProxy(
        wc,
        () => this.browserManager.holdPaintForCapture(webContentsId),
        () => this.browserManager.guardUserFocusForAgentInput(webContentsId),
        (input) => this.browserManager.showAgentPointer(wc, input)
      )
      const cdpEndpoint = await proxy.start()

      this.sessions.set(sessionName, {
        proxy,
        cdpEndpoint,
        initialized: false,
        consecutiveTimeouts: 0,
        activeInterceptPatterns: [],
        activeCapture: false,
        lastCommandAt: Date.now(),
        webContentsId,
        activeProcess: null
      })
      this.watchPopupClose(webContentsId)
    }

    // Proxy sockets outlive individual remote requests and must not inherit their revocable scope.
    const promise = runOutsideRemoteCliBrowserScope(createSession)
    this.pendingSessionCreation.set(sessionName, promise)
    try {
      await promise
    } finally {
      this.pendingSessionCreation.delete(sessionName)
    }
  }

  protected async destroySession(
    sessionName: string,
    options: AgentBrowserCleanupOptions = { closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS }
  ): Promise<void> {
    const pendingDestruction = this.pendingSessionDestruction.get(sessionName)
    if (pendingDestruction) {
      await pendingDestruction
      return
    }

    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      // Wait for creation so a late proxy cannot survive teardown.
      try {
        await pendingCreation
      } catch {
        // The creating caller handles its error; teardown still rejects queued commands.
      }
    }

    const session = this.sessions.get(sessionName)
    if (!session) {
      if (!options.keepQueuedCommands) {
        this.rejectQueuedCommandsForClosedSession(sessionName)
      }
      return
    }

    this.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)
    // Retirement preserves the live page's routes for its replacement session.
    if (options.keepQueuedCommands && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }

    if (!options.keepQueuedCommands) {
      this.rejectQueuedCommandsForClosedSession(sessionName)
    }

    if (session.activeProcess) {
      // Cancel running work immediately instead of waiting for its exec timeout.
      this.cancelledProcesses.add(session.activeProcess)
      try {
        session.activeProcess.kill()
      } catch {}
      session.activeProcess = null
    }

    const destroy = (async (): Promise<void> => {
      try {
        // Close the named daemon within the quit barrier's budget.
        await this.runAgentBrowserRaw(
          sessionName,
          ['--session', sessionName, 'close'],
          options.closeTimeoutMs === undefined ? undefined : { timeoutMs: options.closeTimeoutMs }
        )
        await waitForAgentBrowserSessionExit({
          ownsSocketDirectory: this.ownsAgentBrowserSocketDirectory,
          socketDirectory: this.agentBrowserEnv.AGENT_BROWSER_SOCKET_DIR,
          sessionName
        })
      } catch {}

      await session.proxy.stop()
    })()
    this.pendingSessionDestruction.set(sessionName, destroy)
    try {
      await destroy
    } finally {
      this.pendingSessionDestruction.delete(sessionName)
    }
  }

  protected rejectQueuedCommandsForClosedSession(sessionName: string): void {
    const queue = this.commandQueues.get(sessionName)
    this.commandQueues.delete(sessionName)
    this.processingQueues.delete(sessionName)
    if (queue) {
      const err = new BrowserError(
        'browser_tab_closed',
        'Tab was closed while commands were queued'
      )
      for (const cmd of queue) {
        cmd.reject(err)
      }
      queue.length = 0
    }
  }
}
