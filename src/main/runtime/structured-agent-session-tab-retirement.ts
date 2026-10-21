/**
 * Removing a structured agent session's chat tab from a live workspace tab snapshot.
 *
 * Extracted from `closeStructuredAgentSessionTab` so that user-initiated tab closes and
 * orchestration settlements (stop / release / discard) retire the same tab the same way, rather
 * than orchestration leaving a dead chat tab behind that re-attaches the session when opened.
 */

import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

/** The snapshot's tab for a structured session, matched by session id and by published tab id. */
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

/**
 * The snapshot with that session's tab pruned, or null when it holds no such tab.
 *
 * Pure: the caller owns storing and emitting, so nothing here can fail a settlement.
 */
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

/**
 * Retires a settled structured worker's chat tab, and cannot fail the settlement that called it.
 *
 * Every caller runs this AFTER it has already proven the session's close, so a snapshot problem
 * here must never be able to turn a proven stop into `release_unknown`: the runtime method is
 * called optionally (a runtime double or an older surface may not have it) and any throw is
 * swallowed. It talks to no renderer, so the startup release reconciler can call it too.
 */
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
