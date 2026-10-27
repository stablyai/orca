/** Share tab retirement between user close and orchestration settlement so dead tabs cannot reattach sessions. */

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

export function findStructuredAgentSessionTab(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  sessionId: string
): RuntimeMobileSessionSnapshotTab | null {
  const tabId = structuredAgentSessionTabId(sessionId)
  return (
    snapshot.tabs.find(
      (candidate) =>
        candidate.type === 'agent-session' &&
        (candidate.sessionId === sessionId || candidate.id === tabId)
    ) ?? null
  )
}

/** Return the pruned snapshot, or null; the caller owns storing/emitting, so this cannot fail settlement. */
export function retireStructuredAgentSessionTabFrom(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  sessionId: string
): RuntimeMobileSessionTabsSnapshot | null {
  const tab = findStructuredAgentSessionTab(snapshot, sessionId)
  if (!tab) {
    return null
  }
  const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tab.id)
  const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter((id) => id !== tab.id),
      activeTabId: group.activeTabId === tab.id ? null : group.activeTabId,
      recentTabIds: group.recentTabIds?.filter((id) => id !== tab.id)
    })),
    tabs: nextTabs
  }
}

/** Retire only after proven close; missing/older runtime methods and snapshot errors must not turn a settled stop into release_unknown. No renderer required. */
export function retireSettledStructuredWorkerTab(
  sessionId: string,
  runtime:
    | { retireStructuredAgentSessionTabFromSnapshot?: (sessionId: string) => boolean }
    | undefined
): void {
  try {
    runtime?.retireStructuredAgentSessionTabFromSnapshot?.(sessionId)
  } catch (error) {
    console.warn('[orchestration] structured worker tab retirement failed', sessionId, error)
  }
}
