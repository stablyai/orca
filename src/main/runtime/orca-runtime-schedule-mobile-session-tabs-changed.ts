// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab } from './orca-runtime-stored-mobile-snapshot-has-stale-preserved-tab'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionMarkdownTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult
} from '../../shared/runtime-types'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../shared/runtime-types'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'

export class OrcaRuntimeWithScheduleMobileSessionTabsChanged extends OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab {
  protected scheduleMobileSessionTabsChanged(worktreeId: string): void {
    this.pendingMobileSessionTabsChangeSequenceByWorktree.set(
      worktreeId,
      ++this.mobileSessionTabsChangeSequence
    )
    this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
  }

  protected cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    this.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
  }

  protected flushScheduledMobileSessionTabsChanged(worktreeId: string): void {
    const changeSequence = this.pendingMobileSessionTabsChangeSequenceByWorktree.get(worktreeId)
    if (changeSequence === undefined) {
      return
    }
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  protected notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    // Why: browser bridge events are already worktree-scoped; don't fan out every workspace snapshot during navigation/tab churn.
    const result = this.toMobileSessionTabsResult(snapshot)
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
  }

  protected notifyMobileSessionTabSnapshots(): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      const result = this.toMobileSessionTabsResult(snapshot)
      const changeSequence = ++this.mobileSessionTabsChangeSequence
      for (const subscription of this.mobileSessionTabListeners) {
        subscription.listener(
          this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
          changeSequence
        )
      }
    }
  }

  protected getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return this.projectMobileSessionTabsForClient(
        {
          worktree: worktreeId,
          publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
          snapshotVersion: 0,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        },
        clientNavigationId
      )
    }
    return this.projectMobileSessionTabsForClient(
      this.toMobileSessionTabsResult(snapshot),
      clientNavigationId
    )
  }

  protected emitMobileSessionTabsSnapshotToClient(
    projected: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    follow = false
  ): void {
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      if (subscription.clientNavigationId === clientNavigationId) {
        subscription.listener(
          follow ? { ...projected, navigationIntent: 'follow' } : projected,
          changeSequence
        )
      }
    }
  }

  protected async resolveMobileMarkdownWorktreeId(
    worktreeSelector: string,
    tabId: string
  ): Promise<string> {
    const worktreeId =
      this.getValidatedExplicitWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorktreeSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  protected getLiveBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo> {
    const liveTabs = this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []
    const byPageId = new Map(liveTabs.map((tab) => [tab.browserPageId, tab]))
    for (const [index, page] of getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .entries()) {
      byPageId.set(page.browserPageId, {
        browserPageId: page.browserPageId,
        index: liveTabs.length + index,
        url: page.url,
        title: page.title,
        active: page.active,
        worktreeId,
        profileId: page.browserProfileId
      })
    }
    return byPageId
  }

  protected collectReturnedSessionTabIds(
    tabs: readonly RuntimeMobileSessionClientTab[]
  ): Set<string> {
    const ids = new Set<string>()
    for (const tab of tabs) {
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      } else if (tab.type === 'browser') {
        ids.add(tab.browserWorkspaceId)
      }
    }
    return ids
  }

  protected sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    if (!groups || groups.length === 0) {
      return undefined
    }
    const returnedIds = this.collectReturnedSessionTabIds(returnedTabs)
    const sanitized = groups
      .map((group): RuntimeMobileSessionTabGroup | null => {
        const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
        if (tabOrder.length === 0) {
          return null
        }
        const activeTabId =
          group.activeTabId && tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder[0] ?? null)
        const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
        return {
          id: group.id,
          activeTabId,
          tabOrder,
          ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
        }
      })
      .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
    return sanitized.length > 0 ? sanitized : undefined
  }
}
