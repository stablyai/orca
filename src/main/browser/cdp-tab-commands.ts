import { webContents } from 'electron'
import type {
  BrowserTabInfo,
  BrowserTabListResult,
  BrowserTabSwitchResult
} from '../../shared/runtime-types'
import { BrowserError } from './browser-error'
import { CdpBridgeCommandModule } from './cdp-bridge-command-module'

export class CdpTabCommands extends CdpBridgeCommandModule {
  setActiveTab(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  getActivePageId(_worktreeId?: string): string | null {
    if (!this.activeWebContentsId) {
      return null
    }
    return this.resolveTabIdSafe(this.activeWebContentsId)
  }

  getPageInfo(
    _worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    // Why: expose the same metadata lookup as other bridges, though the CDP bridge routes only one active tab.
    const resolvedPageId = browserPageId ?? this.getActivePageId()
    if (!resolvedPageId) {
      return null
    }
    const webContentsId = this.getRegisteredTabs().get(resolvedPageId)
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

    for (const [tabId, wcId] of this.getRegisteredTabs()) {
      const guest = webContents.fromId(wcId)
      if (!guest || guest.isDestroyed()) {
        continue
      }
      tabs.push({
        browserPageId: tabId,
        index,
        url: guest.getURL(),
        title: guest.getTitle(),
        active: wcId === this.activeWebContentsId
      })
      index++
    }

    return { tabs }
  }

  tabSwitch(index: number): BrowserTabSwitchResult {
    // Why: filter to live tabs so indices match tabList(), skipping destroyed-but-uncleaned entries.
    const liveEntries = [...this.getRegisteredTabs()].filter(([_tabId, wcId]) => {
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
    if (this.activeWebContentsId !== null) {
      this.invalidateRefMap(this.activeWebContentsId)
    }
    this.activeWebContentsId = wcId

    return { switched: index, browserPageId: tabId }
  }

  onTabClosed(webContentsId: number): void {
    if (this.activeWebContentsId === webContentsId) {
      this.activeWebContentsId = null
    }
    const tabId = this.resolveTabIdSafe(webContentsId)
    if (tabId) {
      const state = this.tabState.get(tabId)
      const guest = webContents.fromId(webContentsId)
      if (state && guest) {
        this.removeDebuggerListeners(guest, state)
      }
      this.tabState.delete(tabId)
      this.commandQueues.delete(tabId)
    }
  }

  onTabChanged(webContentsId: number): void {
    this.activeWebContentsId = webContentsId
  }
}
