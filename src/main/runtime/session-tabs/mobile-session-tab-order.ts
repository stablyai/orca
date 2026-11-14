import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as BrowserOwnership } from './mobile-session-publication-preservation'
import type { BrowserTabInfo } from '../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import { RuntimeHeadlessTerminalTabTitles } from './headless-terminal-tab-titles'
export abstract class RuntimeMobileSessionTabOrder extends RuntimeHeadlessTerminalTabTitles {
  protected abstract isRendererOwnedMobileBrowserTab(
    ...args: Parameters<BrowserOwnership['isRendererOwnedMobileBrowserTab']>
  ): ReturnType<BrowserOwnership['isRendererOwnedMobileBrowserTab']>

  protected abstract getListedBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo>

  protected normalizeMobileSessionTabOrder(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    targetGroup: RuntimeMobileSessionTabGroup,
    tabOrder: readonly string[]
  ): string[] {
    const normalized: string[] = []
    const seen = new Set<string>()
    for (const tabId of tabOrder) {
      const hostTabId = this.resolveMobileSessionHostTabId(snapshot, tabId)
      if (!hostTabId) {
        throw new Error('invalid_tab_order')
      }
      if (seen.has(hostTabId)) {
        throw new Error('duplicate_tab_order')
      }
      seen.add(hostTabId)
      normalized.push(hostTabId)
    }

    const returnedIds = this.collectPublicMobileSessionTabIds(snapshot)
    const expected = targetGroup.tabOrder
      .map((tabId) => this.resolveMobileSessionHostTabId(snapshot, tabId) ?? tabId)
      // Reorder the sanitized client model; raw groups may contain browser ids hidden from paired web clients.
      .filter((tabId) => returnedIds.has(tabId))
    const structuredIds = expected.filter((tabId) =>
      snapshot?.tabs.some((tab) => tab.type === 'agent-session' && tab.id === tabId)
    )
    if (structuredIds.some((tabId) => !seen.has(tabId))) {
      if (structuredIds.some((tabId) => seen.has(tabId))) {
        throw new Error('invalid_tab_order')
      }
      const visibleExpected = expected.filter((tabId) => !structuredIds.includes(tabId))
      if (
        normalized.length !== visibleExpected.length ||
        visibleExpected.some((tabId) => !seen.has(tabId))
      ) {
        throw new Error('invalid_tab_order')
      }
      for (const tabId of structuredIds) {
        normalized.splice(Math.min(expected.indexOf(tabId), normalized.length), 0, tabId)
      }
      return normalized
    }
    // Only permute this group; missing/extra ids could move or lose host tabs.
    if (normalized.length !== expected.length || expected.some((tabId) => !seen.has(tabId))) {
      throw new Error('invalid_tab_order')
    }
    return normalized
  }

  protected collectPublicMobileSessionTabIds(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined
  ): Set<string> {
    const ids = new Set<string>()
    if (!snapshot) {
      return ids
    }
    const liveBrowserTabsByPageId = this.getListedBrowserTabsByPageId(snapshot.worktree)
    for (const tab of snapshot.tabs) {
      if (tab.type === 'browser') {
        const liveTab = tab.browserPageId
          ? liveBrowserTabsByPageId.get(tab.browserPageId)
          : undefined
        if (!liveTab && !this.isRendererOwnedMobileBrowserTab(snapshot, tab)) {
          continue
        }
        ids.add(tab.id)
        ids.add(tab.browserWorkspaceId)
        continue
      }
      ids.add(tab.id)
      if (tab.type === 'terminal') {
        ids.add(tab.parentTabId)
      }
    }
    return ids
  }

  protected resolveMobileSessionHostTabId(
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    tabId: string
  ): string | null {
    const tab =
      snapshot?.tabs.find((candidate) => candidate.id === tabId) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
      ) ??
      snapshot?.tabs.find(
        (candidate) => candidate.type === 'browser' && candidate.browserWorkspaceId === tabId
      )
    if (!tab) {
      return null
    }
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }
}
