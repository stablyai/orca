import { webContents } from 'electron'
import { BrowserError } from './browser-error'
import type { CdpTabState } from './cdp-auxiliary-commands'

export type CdpQueuedCommand = {
  execute: () => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export type CdpBridgeStateBindings = {
  getActiveWebContentsId: () => number | null
  setActiveWebContentsId: (webContentsId: number | null) => void
  getRegisteredTabs: () => Map<string, number>
  getTabIdForWebContentsId: (webContentsId: number) => string | null
  tabState: Map<string, CdpTabState>
  commandQueues: Map<string, CdpQueuedCommand[]>
  processingQueues: Set<string>
}

export class CdpBridgeState {
  constructor(private readonly bindings: CdpBridgeStateBindings) {}

  get activeWebContentsId(): number | null {
    return this.bindings.getActiveWebContentsId()
  }

  set activeWebContentsId(webContentsId: number | null) {
    this.bindings.setActiveWebContentsId(webContentsId)
  }

  get tabState(): Map<string, CdpTabState> {
    return this.bindings.tabState
  }

  get commandQueues(): Map<string, CdpQueuedCommand[]> {
    return this.bindings.commandQueues
  }

  get processingQueues(): Set<string> {
    return this.bindings.processingQueues
  }

  // ── Private helpers ──

  getActiveGuest(): Electron.WebContents {
    if (this.activeWebContentsId !== null) {
      const guest = webContents.fromId(this.activeWebContentsId)
      if (guest && !guest.isDestroyed()) {
        return guest
      }
      // Why: webContentsId goes stale after a process swap; fall through to auto-select since the tab may have a new id.
      this.activeWebContentsId = null
    }

    const tabs = [...this.getRegisteredTabs()]
    if (tabs.length === 0) {
      throw new BrowserError(
        'browser_no_tab',
        'No browser tab is open. Use the Orca UI to open a browser tab first.'
      )
    }
    if (tabs.length === 1) {
      this.activeWebContentsId = tabs[0][1]
    } else {
      throw new BrowserError(
        'browser_no_tab',
        "Multiple browser tabs are open. Run 'orca tab list' and 'orca tab switch --index <n>' to select one."
      )
    }

    const guest = webContents.fromId(this.activeWebContentsId!)
    if (!guest || guest.isDestroyed()) {
      this.activeWebContentsId = null
      throw new BrowserError(
        'browser_debugger_detached',
        "The active browser tab was closed. Run 'orca tab list' to find remaining tabs."
      )
    }
    return guest
  }

  getRegisteredTabs(): Map<string, number> {
    return this.bindings.getRegisteredTabs()
  }

  resolveTabId(webContentsId: number): string {
    const tabId = this.bindings.getTabIdForWebContentsId(webContentsId)
    if (tabId !== null) {
      return tabId
    }
    throw new BrowserError('browser_debugger_detached', 'Tab is no longer registered.')
  }

  resolveTabIdSafe(webContentsId: number): string | null {
    return this.bindings.getTabIdForWebContentsId(webContentsId)
  }

  getOrCreateTabState(tabId: string): CdpTabState {
    let state = this.tabState.get(tabId)
    if (!state) {
      state = {
        navigationId: null,
        snapshotResult: null,
        debuggerAttached: false,
        debuggerDetachListener: null,
        debuggerMessageListener: null,
        iframeSessions: new Map(),
        capturing: false,
        consoleLog: [],
        networkLog: [],
        intercepting: false,
        interceptPatterns: [],
        pausedRequests: new Map(),
        networkRequestMap: new Map()
      }
      this.tabState.set(tabId, state)
    }
    return state
  }

  invalidateRefMap(webContentsId: number): void {
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.tabState.get(tabId)
      if (state) {
        state.snapshotResult = null
        state.navigationId = null
      }
    }
  }

  async enqueueCommand<T>(execute: () => Promise<T>): Promise<T> {
    const guest = this.getActiveGuest()
    const tabId = this.resolveTabId(guest.id)

    return new Promise<T>((resolve, reject) => {
      let queue = this.commandQueues.get(tabId)
      if (!queue) {
        queue = []
        this.commandQueues.set(tabId, queue)
      }
      queue.push({
        execute: execute as () => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      })
      this.processQueue(tabId)
    })
  }

  private async processQueue(tabId: string): Promise<void> {
    if (this.processingQueues.has(tabId)) {
      return
    }
    this.processingQueues.add(tabId)

    const queue = this.commandQueues.get(tabId)
    while (queue && queue.length > 0) {
      const cmd = queue.shift()!
      try {
        const result = await cmd.execute()
        cmd.resolve(result)
      } catch (error) {
        cmd.reject(error)
      }
    }

    this.processingQueues.delete(tabId)
  }
}
