import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { collectLayoutLeafCounts } from '../restoring-sessions/terminal-layout-normalization'

/** Live holders per leaf id: tabs whose row exists and whose layout places the leaf. */
export type LiveLeafHolders = ReadonlyMap<string, ReadonlySet<string>>

export function collectLiveLeafHolders(
  sessions: readonly WorkspaceSessionState[]
): LiveLeafHolders {
  const holders = new Map<string, Set<string>>()
  for (const session of sessions) {
    const liveTabIds = new Set(
      Object.values(session.tabsByWorktree ?? {}).flatMap((tabs) => tabs.map((tab) => tab.id))
    )
    for (const [layoutTabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
      if (liveTabIds.has(layoutTabId) && layout?.root) {
        for (const leafId of collectLayoutLeafCounts(layout.root).keys()) {
          const tabs = holders.get(leafId) ?? new Set<string>()
          tabs.add(layoutTabId)
          holders.set(leafId, tabs)
        }
      }
    }
  }
  return holders
}

/**
 * The live tab that holds a leaf, for a hook key whose tab no longer does. Returns the given tab
 * while it still holds the leaf, the single other holder otherwise, and null for none or several.
 * A layout left behind by a removed tab row owns nothing.
 */
export function pickLiveLeafOwnerTabId(
  holders: LiveLeafHolders,
  tabId: string,
  leafId: string
): string | null {
  const tabs = holders.get(leafId)
  if (tabs?.has(tabId)) {
    return tabId
  }
  return tabs?.size === 1 ? ([...tabs][0] ?? null) : null
}

export function findLiveLeafOwnerTabId(
  sessions: readonly WorkspaceSessionState[],
  tabId: string,
  leafId: string
): string | null {
  return pickLiveLeafOwnerTabId(collectLiveLeafHolders(sessions), tabId, leafId)
}
