import { CdpWsProxy } from './cdp-ws-proxy'
import { BrowserError } from './cdp-bridge'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import { AgentBrowserBridgeRawProcess } from './agent-browser-bridge-raw-process'
import type { AgentBrowserCleanupOptions } from './agent-browser-bridge-types'
import { AGENT_BROWSER_CLEANUP_TIMEOUT_MS } from './agent-browser-bridge-types'

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

  /**
   * Retire a page's daemon by page id.
   *
   * The headless offscreen backend owns pages by id and unregisters the guest
   * itself, so `onTabClosed`'s webContentsId lookup can never resolve one — it
   * has to say which page closed (#16367).
   */
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
    // Why: an Electron process swap keeps browserPageId but gives a new webContentsId — destroy the session so the next command recreates it.
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    const session = this.sessions.get(sessionName)
    const oldWebContentsId = previousWebContentsId ?? session?.webContentsId
    const owningWorktreeId = this.browserManager.getWorktreeIdForTab(browserPageId)
    // Why: save intercept patterns before destroy so the new session can restore them after init.
    if (session && session.activeInterceptPatterns.length > 0) {
      this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
    }
    await this.destroySession(sessionName)
    if (oldWebContentsId != null && this.activeWebContentsId === oldWebContentsId) {
      this.activeWebContentsId = newWebContentsId
    }
    if (
      owningWorktreeId &&
      oldWebContentsId != null &&
      this.activeWebContentsPerWorktree.get(owningWorktreeId) === oldWebContentsId
    ) {
      this.activeWebContentsPerWorktree.set(owningWorktreeId, newWebContentsId)
    }
    this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
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

    if (this.sessions.has(sessionName)) {
      return
    }

    // Why: without this lock, two concurrent calls both create proxies and the second leaks the first's server/debugger.
    const pending = this.pendingSessionCreation.get(sessionName)
    if (pending) {
      await pending
      this.assertCommandAdmission()
      return
    }

    const createSession = async (): Promise<void> => {
      const wc = this.getWebContents(webContentsId)
      if (!wc) {
        // Why: the webview can be destroyed between target resolution and session creation — keep the same closed-tab error shape.
        throw new BrowserError(
          'browser_tab_not_found',
          `Browser page ${browserPageId} is no longer available`
        )
      }

      // Why: the daemon persists sessions (incl. CDP port) across restarts; close the stale one first or it ignores --cdp and hits the dead port.
      await this.closeStaleAgentBrowserSession(sessionName)

      const proxy = new CdpWsProxy(wc)
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
    }

    const promise = createSession()
    this.pendingSessionCreation.set(sessionName, promise)
    try {
      await promise
    } finally {
      this.pendingSessionCreation.delete(sessionName)
    }
  }

  protected async restartSessionForTarget(
    sessionName: string,
    browserPageId: string,
    webContentsId: number,
    options: { recreate: boolean } = { recreate: true }
  ): Promise<void> {
    const pendingCreation = this.pendingSessionCreation.get(sessionName)
    if (pendingCreation) {
      await pendingCreation.catch(() => {})
    }

    const session = this.sessions.get(sessionName)
    if (session) {
      if (session.activeInterceptPatterns.length > 0) {
        this.pendingInterceptRestore.set(sessionName, [...session.activeInterceptPatterns])
      }
      this.sessions.delete(sessionName)
      this.pendingSessionCreation.delete(sessionName)
      if (session.activeProcess) {
        this.cancelledProcesses.add(session.activeProcess)
        try {
          session.activeProcess.kill()
        } catch {
          // Process may already be exiting.
        }
        session.activeProcess = null
      }

      const destroy = (async (): Promise<void> => {
        try {
          await this.runAgentBrowserRaw(sessionName, ['--session', sessionName, 'close'], {
            timeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS
          })
        } catch {
          // Session may already be dead.
        }
        await session.proxy.stop()
      })()
      this.pendingSessionDestruction.set(sessionName, destroy)
      try {
        await destroy
      } finally {
        this.pendingSessionDestruction.delete(sessionName)
      }
    }

    if (options.recreate) {
      await this.ensureSession(sessionName, browserPageId, webContentsId)
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
      // Why: tab close can race session creation before sessions.set(); await it so no late proxy survives the close.
      try {
        await pendingCreation
      } catch {
        // Creation failures are handled by the original caller; teardown still rejects queued work below.
      }
    }

    const session = this.sessions.get(sessionName)
    if (!session) {
      this.rejectQueuedCommandsForClosedSession(sessionName)
      return
    }

    this.sessions.delete(sessionName)
    this.pendingSessionCreation.delete(sessionName)

    // Why: queued commands would hang forever if we just delete the queue — drain and reject them.
    this.rejectQueuedCommandsForClosedSession(sessionName)

    if (session.activeProcess) {
      // Why: rejecting the queue isn't enough for an in-flight command — kill the process so callers don't wait out the exec timeout.
      this.cancelledProcesses.add(session.activeProcess)
      try {
        session.activeProcess.kill()
      } catch {
        // Process may already be exiting.
      }
      session.activeProcess = null
    }

    const destroy = (async (): Promise<void> => {
      try {
        // Why: each tab has its own named session — close without --session leaves this tab's daemon running.
        // Why bounded: this runs inside the 20s will-quit barrier, so it cannot inherit the 90s exec timeout.
        await this.runAgentBrowserRaw(
          sessionName,
          ['--session', sessionName, 'close'],
          options.closeTimeoutMs === undefined ? undefined : { timeoutMs: options.closeTimeoutMs }
        )
      } catch {
        // Session may already be dead
      }

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
