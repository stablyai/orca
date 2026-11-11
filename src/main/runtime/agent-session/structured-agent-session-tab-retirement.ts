import { retireMobileSessionTabSelection } from '../session-tabs/mobile-session-tab-selection'
/** Share tab retirement between user close and orchestration settlement so dead tabs cannot reattach sessions. */

import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'

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
  sessionId: string,
  expectedTabId?: string
): RuntimeMobileSessionTabsSnapshot | null {
  const tab = findStructuredAgentSessionTab(snapshot, sessionId)
  if (!tab || (expectedTabId !== undefined && tab.id !== expectedTabId)) {
    return null
  }
  const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tab.id)
  return retireMobileSessionTabSelection(
    { ...snapshot, snapshotVersion: snapshot.snapshotVersion + 1 },
    nextTabs,
    new Set([tab.id])
  )
}

/** Retire only after proven close; missing/older runtime methods and snapshot errors must not turn a settled stop into release_unknown. No renderer required. */
export function retireSettledStructuredWorkerTab(
  sessionId: string,
  runtime:
    | {
        retireStructuredAgentSessionTabFromSnapshot?: (
          sessionId: string,
          expectedTabId?: string
        ) => boolean
      }
    | undefined,
  expectedTabId: string | null
): void {
  if (!expectedTabId) {
    return
  }
  try {
    runtime?.retireStructuredAgentSessionTabFromSnapshot?.(sessionId, expectedTabId)
  } catch (error) {
    console.warn('[orchestration] structured worker tab retirement failed', sessionId, error)
  }
}
