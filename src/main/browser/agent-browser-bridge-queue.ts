import type { BrowserTabSwitchResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeShutdown } from './agent-browser-bridge-shutdown'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import type {
  EnqueueTargetedCommandOptions,
  ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'
import { runWithRemoteCliPageAdmission } from './remote-cli-page-admission'
import { AGENT_BROWSER_CLEANUP_TIMEOUT_MS } from './agent-browser-bridge-types'
import { releaseHeldPageInput } from './guest-direct-key-input'
import {
  captureRemoteCliBrowserRevocation,
  captureRemoteCliBrowserScope,
  runOutsideRemoteCliBrowserScope
} from '../runtime/desktop-browser-bridge/remote-cli-browser-scope'

export abstract class AgentBrowserBridgeQueue extends AgentBrowserBridgeShutdown {
  // Serialize tab switches behind commands targeting the current tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // The tab list may change while this switch waits in the queue.
      const liveEntries = [...tabs.entries()].filter(([, wcId]) => this.getWebContents(wcId))
      let switchedIndex = index ?? -1
      let resolvedPageId = browserPageId
      if (resolvedPageId) {
        switchedIndex = liveEntries.findIndex(([tabId]) => tabId === resolvedPageId)
      }
      if (switchedIndex < 0 || switchedIndex >= liveEntries.length) {
        const targetLabel =
          resolvedPageId != null ? `Browser page ${resolvedPageId}` : `Tab index ${index}`
        throw new BrowserError(
          'browser_tab_not_found',
          `${targetLabel} out of range (0-${liveEntries.length - 1})`
        )
      }
      const [tabId, wcId] = liveEntries[switchedIndex]
      this.activeWebContentsId = wcId
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Page-only switches must also update the owning workspace for later scoped commands.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }

  protected async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(worktreeId, undefined, execute)
  }

  protected async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    const assertNotRevoked = captureRemoteCliBrowserRevocation()
    const origin = captureRemoteCliBrowserScope()
    assertNotRevoked()
    const { browserPageId: pageId } = this.resolveCommandTarget(
      worktreeId,
      browserPageId,
      options.requireScopedTarget
    )
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${pageId}`

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: () => {
          assertNotRevoked()
          const run = (): Promise<T> =>
            this.executeQueuedCommand(
              worktreeId,
              pageId,
              (session, target) => {
                const gate = (): void => assertNotRevoked(target.webContentsId)
                gate()
                return origin.bridged
                  ? this.runHostCommand(session, target.webContentsId, gate, origin, () =>
                      execute(session, target)
                    )
                  : execute(session, target)
              },
              options
            )
          return origin.run(run)
        },
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  protected async executeQueuedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    this.assertCommandAdmission()
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${browserPageId}`
    // A queued page may acquire a replacement guest before execution.
    const target = this.resolveCommandTarget(worktreeId, browserPageId)
    if (options.ensureSession !== false) {
      await this.ensureSession(sessionName, browserPageId, target.webContentsId)
    }
    return execute(sessionName, target)
  }

  /** Revocation must stop every later step of a host command. */
  private runHostCommand<T>(
    sessionName: string,
    webContentsId: number,
    gate: () => void,
    { revoked, hostRevoked }: { revoked?: AbortSignal; hostRevoked?: AbortSignal },
    execute: () => Promise<T>
  ): Promise<T> {
    return runWithRemoteCliPageAdmission(webContentsId, gate, execute, {
      revoked,
      hostRevoked,
      inPageTurn: (work) => this.enqueueDesktopPageWork(sessionName, work),
      retire: () =>
        this.destroySession(sessionName, {
          closeTimeoutMs: AGENT_BROWSER_CLEANUP_TIMEOUT_MS,
          keepQueuedCommands: true
        }),
      releaseHeld: (release) => {
        const wc = this.getWebContents(webContentsId)
        return wc
          ? releaseHeldPageInput(wc, release, () =>
              this.browserManager.guardUserFocusForAgentInput(webContentsId)
            )
          : Promise.resolve()
      }
    })
  }

  /** Serialize desktop cleanup with commands on the same page. */
  private enqueueDesktopPageWork(sessionName: string, work: () => Promise<void>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({ execute: () => runOutsideRemoteCliBrowserScope(work), resolve, reject })
      void this.processQueue(sessionName)
    })
  }

  protected async processQueue(sessionName: string): Promise<void> {
    if (this.processingQueues.has(sessionName)) {
      return
    }
    this.processingQueues.add(sessionName)

    const queue = this.commandQueues.get(sessionName)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    if (queue && queue.length === 0 && this.commandQueues.get(sessionName) === queue) {
      this.commandQueues.delete(sessionName)
    }
    this.processingQueues.delete(sessionName)
  }
}
