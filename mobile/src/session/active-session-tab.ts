import { pickNextTabAfterClose } from '../../../src/shared/session-tab-close-successor'

type SessionTabLike = {
  id: string
  isActive: boolean
}

export type ActiveSessionTabSelectionSource =
  | 'snapshot'
  | 'pending-tab'
  | 'selected-tab'
  | 'navigation-intent'

export type ResolveActiveSessionTabResult<T extends SessionTabLike> = {
  activeTab: T | null
  selectionSource: ActiveSessionTabSelectionSource
  clearPendingActiveSessionTabId: boolean
  retainSelectedSessionTabId: boolean
}

export function resolveActiveSessionTab<T extends SessionTabLike>(
  tabs: readonly T[],
  opts: {
    pendingActiveSessionTabId: string | null
    selectedSessionTabId: string | null
    previousActiveTabId?: string | null
    recentTabIds?: readonly string[]
    navigationIntent?: 'follow'
  }
): ResolveActiveSessionTabResult<T> {
  const previousActive = opts.previousActiveTabId
    ? (tabs.find((tab) => tab.id === opts.previousActiveTabId) ?? null)
    : null
  const snapshotActive =
    tabs.find((tab) => tab.isActive) ??
    previousActive ??
    (opts.previousActiveTabId
      ? pickNextTabAfterClose(tabs, opts.previousActiveTabId, opts.recentTabIds)
      : null) ??
    tabs[0] ??
    null
  const pendingActiveSessionTabId = opts.pendingActiveSessionTabId
  // Why: targeted follow is the only host action allowed to supersede phone-local intent.
  if (opts.navigationIntent === 'follow') {
    return {
      activeTab: snapshotActive,
      selectionSource: 'navigation-intent',
      clearPendingActiveSessionTabId: pendingActiveSessionTabId !== null,
      retainSelectedSessionTabId: false
    }
  }
  if (pendingActiveSessionTabId) {
    if (snapshotActive?.id === pendingActiveSessionTabId) {
      return {
        activeTab: snapshotActive,
        selectionSource: 'snapshot',
        clearPendingActiveSessionTabId: true,
        retainSelectedSessionTabId: false
      }
    }
    const pendingTab = tabs.find((tab) => tab.id === pendingActiveSessionTabId) ?? null
    if (pendingTab) {
      return {
        activeTab: pendingTab,
        selectionSource: 'pending-tab',
        clearPendingActiveSessionTabId: false,
        retainSelectedSessionTabId: false
      }
    }
  }
  const clearPendingActiveSessionTabId = pendingActiveSessionTabId !== null
  const selectedTab = opts.selectedSessionTabId
    ? (tabs.find((tab) => tab.id === opts.selectedSessionTabId) ?? null)
    : null
  return {
    activeTab: selectedTab ?? snapshotActive,
    selectionSource: selectedTab ? 'selected-tab' : 'snapshot',
    clearPendingActiveSessionTabId,
    // Why: transient browser guest swaps must not erase the device's explicit pick.
    retainSelectedSessionTabId: Boolean(opts.selectedSessionTabId) && !selectedTab
  }
}
