import { webContents } from 'electron'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult
} from '../../../../shared/runtime-browser-contracts'
import { BrowserError } from '../../browser-error'
import type { CdpBridgeState } from './cdp-bridge-state'
import type { CdpDebuggerLifecycle } from '../debugger/cdp-debugger-lifecycle'

export class CdpTabCommands {
  constructor(
    private readonly bridgeState: CdpBridgeState,
    private readonly debuggerLifecycle: CdpDebuggerLifecycle
  ) {}

  setActiveTab(webContentsId: number): void {
    this.bridgeState.activeWebContentsId = webContentsId
  }

  getActiveWebContentsId(): number | null {
    return this.bridgeState.activeWebContentsId
  }

  getActivePageId(_worktreeId?: string): string | null {
    if (!this.bridgeState.activeWebContentsId) {
      return null
    }
    return this.bridgeState.resolveTabIdSafe(this.bridgeState.activeWebContentsId)
  }

  getPageInfo(
    _worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    const resolvedPageId = browserPageId ?? this.getActivePageId()
    if (!resolvedPageId) {
      return null
    }
    const webContentsId = this.bridgeState.getRegisteredTabs().get(resolvedPageId)
    if (webContentsId == null) {
      return null
    }
    const guest = webContents.fromId(webContentsId)
    if (!guest || guest.isDestroyed()) {
      return null
    }
    return {
      browserPageId: resolvedPageId,
      url: guest.getURL(),
      title: guest.getTitle()
    }
  }

  tabList(): BrowserTabListResult {
    const tabs: BrowserTabInfo[] = []
    let index = 0

    for (const [tabId, wcId] of this.bridgeState.getRegisteredTabs()) {
      const guest = webContents.fromId(wcId)
      if (!guest || guest.isDestroyed()) {
        continue
      }
      tabs.push({
        browserPageId: tabId,
        index,
        url: guest.getURL(),
        title: guest.getTitle(),
        active: wcId === this.bridgeState.activeWebContentsId
      })
      index++
    }

    return { tabs }
  }

  tabSwitch(index: number): BrowserTabSwitchResult {
    // Keep indices aligned with tabList(), which skips destroyed guests.
    const liveEntries = [...this.bridgeState.getRegisteredTabs()].filter(([_tabId, wcId]) => {
      const guest = webContents.fromId(wcId)
      return guest && !guest.isDestroyed()
    })
    if (index < 0 || index >= liveEntries.length) {
      throw new BrowserError(
        'browser_tab_not_found',
        `Tab index ${index} is out of range. ${liveEntries.length} tab(s) open.`
      )
    }

    const [tabId, wcId] = liveEntries[index]
    if (this.bridgeState.activeWebContentsId !== null) {
      this.bridgeState.invalidateRefMap(this.bridgeState.activeWebContentsId)
    }
    this.bridgeState.activeWebContentsId = wcId

    return { switched: index, browserPageId: tabId }
  }

  onTabClosed(webContentsId: number): void {
    if (this.bridgeState.activeWebContentsId === webContentsId) {
      this.bridgeState.activeWebContentsId = null
    }
    const tabId = this.bridgeState.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.bridgeState.tabState.get(tabId)
      const guest = webContents.fromId(webContentsId)
      if (state && guest) {
        this.debuggerLifecycle.removeDebuggerListeners(guest, state)
      }
      this.bridgeState.tabState.delete(tabId)
      this.bridgeState.commandQueues.delete(tabId)
    }
  }

  onTabChanged(webContentsId: number): void {
    this.bridgeState.activeWebContentsId = webContentsId
  }
}
