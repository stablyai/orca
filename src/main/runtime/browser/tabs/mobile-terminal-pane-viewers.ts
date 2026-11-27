import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/workspace-layout/stable-pane-id'

export function activeMobileViewerClientIdsForPane(
  source: {
    getLeafPtyId(tabId: string, leafId: string): string | null | undefined
    getPanePtyId(paneKey: string): string | null | undefined
    getDisplayMode(ptyId: string): string
    getDriverKind?(ptyId: string): string
    getSubscribers(ptyId: string): Iterable<{ clientId: string; viewport: unknown }> | undefined
    getMobileListenerIds?(worktreeId: string): string[]
    getClientActiveTabId?(clientId: string, worktreeId: string): string | null
    getMobileSessionSnapshot?(worktreeId: string): RuntimeMobileSessionTabsSnapshot | undefined
  },
  paneKey: string,
  worktreeId?: string
): string[] {
  const parsed = parsePaneKey(paneKey)
  const ptyId =
    (parsed ? source.getLeafPtyId(parsed.tabId, parsed.leafId) : null) ??
    source.getPanePtyId(paneKey) ??
    null
  const desktopReclaimed =
    ptyId !== null &&
    (source.getDriverKind
      ? source.getDriverKind(ptyId) === 'desktop'
      : source.getDisplayMode(ptyId) === 'desktop')
  if (desktopReclaimed) {
    return []
  }
  const ptyViewers =
    ptyId !== null
      ? [...(source.getSubscribers(ptyId) ?? [])]
          .filter((s) => s.viewport !== null)
          .map((s) => s.clientId)
      : []
  const tabId = parsed?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
  if (!worktreeId || !source.getMobileListenerIds) {
    return ptyViewers
  }
  const listenerIds = source.getMobileListenerIds(worktreeId)
  if (listenerIds.length === 0 || (!tabId && !ptyId)) {
    return []
  }
  // Resolve in the pairedDeviceId namespace used by session.tabs navigation so multi-device targeting stays isolated.
  const snapshot = source.getMobileSessionSnapshot?.(worktreeId)
  const matchingTabIds = new Set(
    snapshot?.tabs
      .filter(
        (t) =>
          (parsed
            ? t.type === 'terminal' && t.parentTabId === parsed.tabId && t.leafId === parsed.leafId
            : tabId !== null &&
              (t.id === tabId || (t.type === 'terminal' && t.parentTabId === tabId))) ||
          (ptyId !== null && t.type === 'terminal' && t.ptyId === ptyId)
      )
      .map((t) => t.id) ?? (tabId ? [tabId] : [])
  )
  const ptyViewerSet = new Set(ptyViewers)
  return listenerIds.filter((clientId) => {
    if (ptyViewerSet.has(clientId)) {
      return true
    }
    const activeId = source.getClientActiveTabId?.(clientId, worktreeId) ?? snapshot?.activeTabId
    return Boolean(activeId && matchingTabIds.has(activeId))
  })
}

export function selectTargetMobileNavigationIds(
  listenerIds: readonly string[],
  paneViewerClientIds?: readonly string[]
): string[] {
  const uniqueListeners = [...new Set(listenerIds)]
  if (!paneViewerClientIds) {
    return uniqueListeners
  }
  const viewerSet = new Set(paneViewerClientIds)
  return uniqueListeners.filter((id) => viewerSet.has(id))
}
