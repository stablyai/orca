import type { BrowserTabInfo, BrowserTabListResult } from '../../shared/runtime-types'
import { BrowserError } from './cdp-bridge'
import type { ResolvedBrowserCommandTarget } from './agent-browser-bridge-types'
import { AgentBrowserBridgeState } from './agent-browser-bridge-state'
import { isAgentRpcCaller } from '../runtime/rpc/rpc-caller-identity'
import { getActiveRpcCaller } from '../runtime/rpc/rpc-active-caller'

export abstract class AgentBrowserBridgeTabs extends AgentBrowserBridgeState {
  setActiveTab(webContentsId: number, worktreeId?: string): void {
    if (isAgentRpcCaller(getActiveRpcCaller())) {
      this.pointAgentAt(webContentsId, worktreeId)
    } else {
      this.selectForPerson(webContentsId, worktreeId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }

  protected pointAgentAt(webContentsId: number, worktreeId?: string): void {
    for (const key of routingKeys(worktreeId)) {
      this.setRoutedWebContentsId(key, webContentsId)
    }
    // Mark the new tab now, or a person's pick before the agent's next command would take it.
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    if (browserPageId) {
      this.browserManager.beginAgentCommand(browserPageId).end()
    }
  }

  // A person's pick never pulls an agent off the tab it is driving; it applies once that tab goes idle.
  private selectForPerson(webContentsId: number, worktreeId?: string): void {
    for (const key of routingKeys(worktreeId)) {
      const current = this.routedWebContentsId(key)
      if (current !== null && current !== webContentsId && this.isAgentUsingTab(current)) {
        this.heldPersonSelections.set(key, webContentsId)
      } else {
        this.setRoutedWebContentsId(key, webContentsId)
        this.heldPersonSelections.delete(key)
      }
    }
  }

  protected applyHeldPersonSelections(worktreeId?: string): void {
    for (const key of routingKeys(worktreeId)) {
      const held = this.heldPersonSelections.get(key)
      const current = this.routedWebContentsId(key)
      if (held === undefined || (current !== null && this.isAgentUsingTab(current))) {
        continue
      }
      this.heldPersonSelections.delete(key)
      if (this.getWebContents(held)) {
        this.setRoutedWebContentsId(key, held)
      }
    }
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

  private isAgentUsingTab(webContentsId: number): boolean {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    return browserPageId !== null && this.browserManager.isAgentUsingPage(browserPageId)
  }

  private routedWebContentsId(key: string | undefined): number | null {
    return key === undefined
      ? this.activeWebContentsId
      : (this.activeWebContentsPerWorktree.get(key) ?? null)
  }

  private setRoutedWebContentsId(key: string | undefined, webContentsId: number): void {
    if (key === undefined) {
      this.activeWebContentsId = webContentsId
    } else {
      this.activeWebContentsPerWorktree.set(key, webContentsId)
    }
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
    this.selectForPerson(webContentsId, worktreeId)
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

  /** Tab list results omit workspace ownership. */
  tabWorktreeIds(): (string | undefined)[] {
    return [...this.getRegisteredTabs(undefined)].map(([tabId]) =>
      this.browserManager.getWorktreeIdForTab(tabId)
    )
  }

  tabList(worktreeId?: string): BrowserTabListResult {
    this.applyHeldPersonSelections(worktreeId)
    const tabs = this.getRegisteredTabs(worktreeId)
    // Match command routing without changing active-tab selection during discovery.
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
        profileId: this.browserManager.getSessionProfileIdForTab(tabId) ?? 'default',
        index: index++,
        // Failed pages report chrome-error:// instead of the requested URL.
        url: loadError?.validatedUrl ?? wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: wcId === activeWcId,
        loadError,
        certificateFailure
      })
    }
    // Infer an active tab for display without changing command routing.
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
    this.applyHeldPersonSelections(worktreeId)
    const tabs = this.getRegisteredTabs(worktreeId)

    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

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

    // Persisted registrations can outlive their WebContents.
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

  // Unscoped text mutations must not reach another worktree or steal focus.
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

function routingKeys(worktreeId: string | undefined): (string | undefined)[] {
  return worktreeId ? [undefined, worktreeId] : [undefined]
}

// agent-browser reads `@e3`, `ref=e3` and bare `e3` as snapshot refs.
function isSnapshotRef(element: string): boolean {
  return /^(?:@|ref=)?e\d+$/.test(element)
}
