import type { BrowserTabInfo, BrowserTabListResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import type { ResolvedBrowserCommandTarget } from './agent-browser-bridge-types'
import { AgentBrowserBridgeState } from './agent-browser-bridge-state'

export abstract class AgentBrowserBridgeTabs extends AgentBrowserBridgeState {
  // ── Tab tracking ──

  setActiveTab(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }

  protected selectFallbackActiveWebContents(
    worktreeId: string,
    excludedWebContentsId?: number
  ): number | null {
    for (const [, wcId] of this.getRegisteredTabs(worktreeId)) {
      if (wcId === excludedWebContentsId) {
        continue
      }
      if (this.getWebContents(wcId)) {
        this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        return wcId
      }
    }
    this.activeWebContentsPerWorktree.delete(worktreeId)
    return null
  }

  getActiveWebContentsId(): number | null {
    return this.activeWebContentsId
  }

  getPageInfo(
    worktreeId?: string,
    browserPageId?: string
  ): { browserPageId: string; url: string; title: string } | null {
    try {
      const target = this.resolveCommandTarget(worktreeId, browserPageId)
      const wc = this.getWebContents(target.webContentsId)
      if (!wc) {
        return null
      }
      return {
        browserPageId: target.browserPageId,
        url: wc.getURL() ?? '',
        title: wc.getTitle() ?? ''
      }
    } catch {
      return null
    }
  }
  onTabChanged(webContentsId: number, worktreeId?: string): void {
    this.activeWebContentsId = webContentsId
    if (worktreeId) {
      this.activeWebContentsPerWorktree.set(worktreeId, webContentsId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }
  getRegisteredTabs(worktreeId?: string): Map<string, number> {
    const all = this.browserManager.getWebContentsIdByTabId()
    if (!worktreeId) {
      return all
    }

    const filtered = new Map<string, number>()
    for (const [tabId, wcId] of all) {
      if (this.browserManager.getWorktreeIdForTab(tabId) === worktreeId) {
        filtered.set(tabId, wcId)
      }
    }
    return filtered
  }

  // ── Tab management ──

  tabList(worktreeId?: string): BrowserTabListResult {
    const tabs = this.getRegisteredTabs(worktreeId)
    // Why: use the per-worktree active tab so listing matches command routing, but read-only — discovery must not mutate active-tab state.
    let activeWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId
    const result: BrowserTabInfo[] = []
    let index = 0
    let firstLiveWcId: number | null = null
    for (const [tabId, wcId] of tabs) {
      const wc = this.getWebContents(wcId)
      if (!wc) {
        this.browserManager.unregisterGuest(tabId)
        continue
      }
      if (firstLiveWcId === null) {
        firstLiveWcId = wcId
      }
      const loadError = this.browserManager.getBrowserPageLoadError(tabId)
      const certificateFailure = this.browserManager.getBrowserPageCertificateFailure(tabId)
      result.push({
        browserPageId: tabId,
        index: index++,
        // Why: failed WebContents report chrome-error://, not the address the user asked to load.
        url: loadError?.validatedUrl ?? wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId,
        loadError,
        certificateFailure
      })
    }
    // Why: with no active tab yet, show the first live tab as active without mutating state — keeps `tab list` side-effect free.
    if (activeWcId == null && firstLiveWcId !== null) {
      activeWcId = firstLiveWcId
      if (result.length > 0) {
        result[0].active = true
      }
    }
    return { tabs: result }
  }
  getActivePageId(worktreeId?: string, browserPageId?: string): string | null {
    try {
      return this.resolveCommandTarget(worktreeId, browserPageId).browserPageId
    } catch {
      return null
    }
  }

  protected resolveCommandTarget(
    worktreeId?: string,
    browserPageId?: string,
    requireScopedTarget = false
  ): ResolvedBrowserCommandTarget {
    if (!browserPageId) {
      return requireScopedTarget
        ? this.resolveScopedActiveTab(worktreeId)
        : this.resolveActiveTab(worktreeId)
    }

    const tabs = this.getRegisteredTabs(worktreeId)
    const webContentsId = tabs.get(browserPageId)
    if (webContentsId == null) {
      const scope = worktreeId ? ' in this worktree' : ''
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} was not found${scope}`
      )
    }

    if (!this.getWebContents(webContentsId)) {
      this.browserManager.unregisterGuest(browserPageId)
      throw new BrowserError(
        'browser_tab_not_found',
        `Browser page ${browserPageId} is no longer available`
      )
    }

    return { browserPageId, webContentsId }
  }

  protected resolveActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    const tabs = this.getRegisteredTabs(worktreeId)

    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

    // Why: prefer per-worktree active tab to avoid cross-worktree interference; fall back to global for callers without worktreeId.
    const preferredWcId =
      (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId)) ?? this.activeWebContentsId

    if (preferredWcId != null) {
      for (const [tabId, wcId] of tabs) {
        if (wcId === preferredWcId && this.getWebContents(wcId)) {
          return { browserPageId: tabId, webContentsId: wcId }
        }
        if (wcId === preferredWcId) {
          this.browserManager.unregisterGuest(tabId)
          if (this.activeWebContentsId === wcId) {
            this.activeWebContentsId = null
          }
          if (worktreeId && this.activeWebContentsPerWorktree.get(worktreeId) === wcId) {
            this.activeWebContentsPerWorktree.delete(worktreeId)
          }
        }
      }
    }

    // Why: persisted state can leave ghost tabs (dead webContents); skip them and activate the first live tab for consistency.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        this.activeWebContentsId = wcId
        if (worktreeId) {
          this.activeWebContentsPerWorktree.set(worktreeId, wcId)
        }
        return { browserPageId: tabId, webContentsId: wcId }
      }
      this.browserManager.unregisterGuest(tabId)
    }

    throw new BrowserError(
      'browser_no_tab',
      'No live browser tab available — all registered tabs have been destroyed'
    )
  }

  // Why: don't fall back to the global tab for text mutation — it could inject into another worktree's foreground webview and steal focus.
  protected resolveScopedActiveTab(worktreeId?: string): ResolvedBrowserCommandTarget {
    if (worktreeId) {
      return this.resolveActiveTab(worktreeId)
    }

    const worktreesWithLiveTabs = new Set<string | undefined>()
    for (const [tabId, wcId] of this.getRegisteredTabs(undefined)) {
      if (this.getWebContents(wcId)) {
        worktreesWithLiveTabs.add(this.browserManager.getWorktreeIdForTab(tabId))
      }
    }

    if (worktreesWithLiveTabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    if (worktreesWithLiveTabs.size > 1) {
      throw new BrowserError(
        'browser_target_ambiguous',
        'Multiple worktrees have browser tabs open; pass --worktree to target text insertion safely'
      )
    }

    const [onlyWorktreeId] = worktreesWithLiveTabs
    return this.resolveActiveTab(onlyWorktreeId)
  }
}
