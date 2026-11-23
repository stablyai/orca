import type {
  BrowserTabInfo,
  BrowserTabListResult
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../../browser-error'
import type { ResolvedBrowserCommandTarget } from './agent-browser-command-target'
import { AgentBrowserBridgeState } from './agent-browser-bridge-state'
import { activeRpcBrowserPagePicker, personPickWaits } from './person-pick-hold'

export abstract class AgentBrowserBridgeTabs extends AgentBrowserBridgeState {
  setActiveTab(webContentsId: number, worktreeId?: string): void {
    if (activeRpcBrowserPagePicker() === 'agent') {
      this.pointAgentAt(webContentsId, worktreeId)
    } else {
      this.selectForPerson(webContentsId, worktreeId)
    }
    this.options.onTabsChanged?.(worktreeId)
  }

  protected pointAgentAt(webContentsId: number, worktreeId?: string): void {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    if (!browserPageId) {
      return
    }
    for (const key of routingKeys(worktreeId)) {
      this.setRoutedPageId(key, browserPageId)
    }
    // Mark the new tab now, or a person's pick before the agent's next command would take it.
    this.browserManager.beginAgentCommand(browserPageId).end()
    this.watchPopupClose(webContentsId)
  }

  protected abstract watchPopupClose(webContentsId: number): void

  /** Page-less commands route to this page now, or will once a person's held pick applies; never picks a fallback. */
  isRoutedPage(browserPageId: string): boolean {
    return (
      this.routedPageId === browserPageId ||
      [...this.routedPagePerWorktree.values(), ...this.heldPersonSelections.values()].includes(
        browserPageId
      )
    )
  }

  // A person's pick never pulls an agent off the tab it is driving; it applies once that tab goes idle.
  private selectForPerson(webContentsId: number, worktreeId?: string): void {
    const browserPageId = this.resolveTabIdSafe(webContentsId)
    if (!browserPageId) {
      return
    }
    for (const key of routingKeys(worktreeId)) {
      if (personPickWaits(this.routedPage(key), browserPageId, this.isAgentUsingPage)) {
        this.setHeldPersonSelection(key, browserPageId)
      } else {
        this.setRoutedPageId(key, browserPageId)
        this.setHeldPersonSelection(key, null)
      }
    }
  }

  protected applyHeldPersonSelections(worktreeId?: string): void {
    for (const key of routingKeys(worktreeId)) {
      const held = this.heldPersonSelections.get(key)
      if (
        held === undefined ||
        personPickWaits(this.routedPage(key), held, this.isAgentUsingPage)
      ) {
        continue
      }
      this.setHeldPersonSelection(key, null)
      this.setRoutedPageId(key, held)
    }
  }

  private readonly isAgentUsingPage = (browserPageId: string): boolean =>
    this.browserManager.isAgentUsingPage(browserPageId)

  private routedPage(key: string | undefined): string | null {
    return key === undefined ? this.routedPageId : (this.routedPagePerWorktree.get(key) ?? null)
  }

  protected selectFallbackRoutedPage(worktreeId: string, excludedPageId: string): string | null {
    // A closing tab's popups close with it, so only tabs can take over.
    for (const [tabId, wcId] of this.registeredTabsWithoutPopups(worktreeId)) {
      if (tabId !== excludedPageId && this.getWebContents(wcId)) {
        this.setRoutedPageId(worktreeId, tabId)
        return tabId
      }
    }
    this.setRoutedPageId(worktreeId, null)
    return null
  }

  getActiveWebContentsId(): number | null {
    return this.routedPageId === null
      ? null
      : (this.getRegisteredPageWebContentsId(this.routedPageId) ?? null)
  }

  /** The page pageless commands target, which may be freed and need restoring before use. */
  getRoutedPageId(worktreeId?: string): string | null {
    this.applyHeldPersonSelections(worktreeId)
    return (
      (worktreeId ? this.routedPagePerWorktree.get(worktreeId) : undefined) ?? this.routedPageId
    )
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
  getRemoteTabFaviconUrl(browserPageId: string): string | null {
    return this.browserManager.getBrowserPageRemoteTabFaviconUrl(browserPageId)
  }
  getPageNavigationState(
    browserPageId: string
  ): { loading: boolean; canGoBack: boolean; canGoForward: boolean } | null {
    return this.browserManager.getBrowserPageNavigationState(browserPageId)
  }
  getPageAudioRowFields(browserPageId: string): { audible?: true; audioMuted?: true } {
    return this.browserManager.getBrowserPageAudioRowFields(browserPageId)
  }
  onTabChanged(webContentsId: number, worktreeId?: string): void {
    this.selectForPerson(webContentsId, worktreeId)
    this.options.onTabsChanged?.(worktreeId)
  }
  getRegisteredTabs(
    worktreeId?: string,
    popupPages = this.browserManager.getPopupPages()
  ): Map<string, number> {
    const tabs = this.registeredTabsWithoutPopups(worktreeId)
    // Popups list after the tabs and share their opener's scope.
    for (const popup of popupPages) {
      if (tabs.has(popup.openerBrowserPageId)) {
        tabs.set(popup.browserPageId, popup.webContentsId)
      }
    }
    return tabs
  }

  /** Tab list results omit workspace ownership. */
  tabWorktreeIds(): (string | undefined)[] {
    return [...this.getRegisteredTabs(undefined)].map(([tabId]) =>
      this.browserManager.getWorktreeIdForTab(tabId)
    )
  }

  tabList(worktreeId?: string): BrowserTabListResult {
    this.applyHeldPersonSelections(worktreeId)
    const popupPages = this.browserManager.getPopupPages()
    const tabs = this.getRegisteredTabs(worktreeId, popupPages)
    const popupOpeners = new Map(
      popupPages.map((popup) => [popup.browserPageId, popup.openerBrowserPageId])
    )
    // Match command routing without changing active-tab selection during discovery.
    const routedPageId =
      (worktreeId ? this.routedPagePerWorktree.get(worktreeId) : undefined) ?? this.routedPageId
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
      const openerBrowserPageId = popupOpeners.get(tabId)
      const loadError = this.browserManager.getBrowserPageLoadError(tabId)
      const certificateFailure = this.browserManager.getBrowserPageCertificateFailure(tabId)
      result.push({
        browserPageId: tabId,
        profileId: this.browserManager.getSessionProfileIdForTab(tabId) ?? 'default',
        index: index++,
        // Failed pages report chrome-error:// instead of the requested URL.
        url: loadError?.validatedUrl ?? wc.getURL() ?? '',
        title: wc.getTitle() ?? '',
        active: tabId === routedPageId,
        loadError,
        certificateFailure,
        ...(openerBrowserPageId ? { openerBrowserPageId } : {})
      })
    }
    // Infer an active tab for display without changing command routing.
    if (routedPageId === null && firstLiveWcId !== null && result.length > 0) {
      result[0].active = true
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

    const webContentsId = this.getRegisteredPageWebContentsId(browserPageId, worktreeId)
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
    const preferredPageId = this.getRoutedPageId(worktreeId)
    const preferredWcId =
      preferredPageId === null
        ? undefined
        : this.getRegisteredPageWebContentsId(preferredPageId, worktreeId)
    if (preferredPageId !== null && preferredWcId !== undefined) {
      if (this.getWebContents(preferredWcId)) {
        return { browserPageId: preferredPageId, webContentsId: preferredWcId }
      }
      this.browserManager.unregisterGuest(preferredPageId)
      if (this.routedPageId === preferredPageId) {
        this.setRoutedPageId(undefined, null)
      }
      if (worktreeId && this.routedPagePerWorktree.get(worktreeId) === preferredPageId) {
        this.setRoutedPageId(worktreeId, null)
      }
    }
    const tabs = this.getRegisteredTabs(worktreeId)
    if (tabs.size === 0) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    // A routed page freed while hidden stays the route; page operations restore it before running.
    const ownRoute = worktreeId
      ? (this.routedPagePerWorktree.get(worktreeId) ?? null)
      : this.routedPageId
    const keepRoute =
      ownRoute !== null &&
      ownRoute === preferredPageId &&
      this.getRegisteredPageWebContentsId(ownRoute) === undefined

    // Persisted registrations can outlive their WebContents.
    for (const [tabId, wcId] of tabs) {
      if (this.getWebContents(wcId)) {
        if (!keepRoute) {
          this.setRoutedPageId(undefined, tabId)
          if (worktreeId) {
            this.setRoutedPageId(worktreeId, tabId)
          }
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
