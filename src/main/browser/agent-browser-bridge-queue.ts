import type { BrowserTabSwitchResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import { AgentBrowserBridgeShutdown } from './agent-browser-bridge-shutdown'
import { ORCA_TAB_SESSION_PREFIX } from './agent-browser-orphan-sweep'
import type {
  EnqueueTargetedCommandOptions,
  ResolvedBrowserCommandTarget
} from './agent-browser-bridge-types'

export abstract class AgentBrowserBridgeQueue extends AgentBrowserBridgeShutdown {
  // Why: route tab switch through the command queue so it can't race in-flight commands targeting the old tab.
  async tabSwitch(
    index: number | undefined,
    worktreeId?: string,
    browserPageId?: string
  ): Promise<BrowserTabSwitchResult> {
    return this.enqueueCommand(worktreeId, async () => {
      const tabs = this.getRegisteredTabs(worktreeId)
      // Why: queue delay can change the tab list before execution — recompute against live webContents so no vanished index is activated.
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
      // Why: resolveActiveTab prefers the per-worktree map, so update it or later commands keep routing to the old tab.
      const owningWorktreeId = worktreeId ?? this.browserManager.getWorktreeIdForTab(tabId)
      // Why: `tab switch --page` may omit --worktree, so still update the owning worktree's active slot for later scoped commands.
      if (owningWorktreeId) {
        this.activeWebContentsPerWorktree.set(owningWorktreeId, wcId)
      }
      this.options.onTabsChanged?.(owningWorktreeId ?? undefined)
      return { switched: switchedIndex, browserPageId: tabId }
    })
  }
  // ── Internal ──

  protected async enqueueCommand<T>(
    worktreeId: string | undefined,
    execute: (sessionName: string) => Promise<T>
  ): Promise<T> {
    return this.enqueueTargetedCommand(
      worktreeId,
      undefined,
      async (sessionName) => execute(sessionName),
      { ensureVisible: false }
    )
  }

  protected async enqueueTargetedCommand<T>(
    worktreeId: string | undefined,
    browserPageId: string | undefined,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions = {}
  ): Promise<T> {
    this.assertCommandAdmission()
    const target = this.resolveCommandTarget(worktreeId, browserPageId, options.requireScopedTarget)
    const sessionName = `${ORCA_TAB_SESSION_PREFIX}${target.browserPageId}`

    if (options.ensureSession !== false) {
      await this.ensureSession(sessionName, target.browserPageId, target.webContentsId)
    }
    this.assertCommandAdmission()

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(sessionName)
      if (!queue) {
        queue = []
        this.commandQueues.set(sessionName, queue)
      }
      queue.push({
        execute: (() =>
          this.executeWithVisibleTarget(
            sessionName,
            worktreeId,
            target,
            execute,
            options
          )) as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(sessionName)
    })
  }

  protected async executeWithVisibleTarget<T>(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    execute: (sessionName: string, target: ResolvedBrowserCommandTarget) => Promise<T>,
    options: EnqueueTargetedCommandOptions
  ): Promise<T> {
    if (options.ensureVisible === false) {
      return execute(sessionName, target)
    }

    // Why: inactive panes are display:none; the automation lease makes only this target paintable without selecting it.
    const restore = await this.browserManager.acquireAutomationVisibility(target.webContentsId)
    try {
      const visibleTarget = await this.refreshTargetAfterAutomationVisibility(
        sessionName,
        worktreeId,
        target,
        options
      )
      return await execute(sessionName, visibleTarget)
    } finally {
      restore()
    }
  }

  protected async refreshTargetAfterAutomationVisibility(
    sessionName: string,
    worktreeId: string | undefined,
    target: ResolvedBrowserCommandTarget,
    options: EnqueueTargetedCommandOptions
  ): Promise<ResolvedBrowserCommandTarget> {
    const visibleTarget = this.resolveCommandTarget(worktreeId, target.browserPageId)
    if (visibleTarget.webContentsId === target.webContentsId) {
      return visibleTarget
    }

    if (this.activeWebContentsId === target.webContentsId) {
      this.activeWebContentsId = visibleTarget.webContentsId
    }
    if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === target.webContentsId) {
      this.activeWebContentsPerWorktree.set(worktreeId, visibleTarget.webContentsId)
    }

    // Why: making a parked webview paintable can re-register the page with a new guest webContents; tear down the stale session.
    await this.restartSessionForTarget(
      sessionName,
      visibleTarget.browserPageId,
      visibleTarget.webContentsId,
      { recreate: options.ensureSession !== false }
    )

    return visibleTarget
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
