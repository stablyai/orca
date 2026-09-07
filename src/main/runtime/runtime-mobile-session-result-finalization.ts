import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import type {
  RuntimeMobileSessionProjectionHost,
  RuntimeMobileSessionProjectionInput
} from './runtime-mobile-session-projection-contract'

export function finalizeRuntimeMobileSessionTabsResult(
  { snapshot, tabs }: RuntimeMobileSessionProjectionInput,
  host: RuntimeMobileSessionProjectionHost
): RuntimeMobileSessionTabsResult {
  const active =
    tabs.find((tab) => tab.isActive && tab.id === snapshot.activeTabId) ??
    tabs.find((tab) => tab.isActive) ??
    (snapshot.activeTabId ? (tabs[0] ?? null) : null)
  const normalizedTabs =
    active && !tabs.some((tab) => tab.isActive)
      ? tabs.map((tab) => (tab.id === active.id ? { ...tab, isActive: true } : tab))
      : tabs
  const tabGroups = host.sanitizeGroups(snapshot.tabGroups, normalizedTabs)
  const validGroupIds = new Set(tabGroups?.map((group) => group.id) ?? [])
  const tabGroupLayout =
    snapshot.tabGroupLayout === undefined
      ? undefined
      : host.pruneGroupLayout(snapshot.tabGroupLayout, validGroupIds)
  const activeGroupId =
    snapshot.activeGroupId && validGroupIds.has(snapshot.activeGroupId)
      ? snapshot.activeGroupId
      : (tabGroups?.find((group) =>
          active ? group.tabOrder.some((tabId) => host.collectTabIds([active]).has(tabId)) : false
        )?.id ??
        tabGroups?.[0]?.id ??
        null)
  return {
    worktree: snapshot.worktree,
    publicationEpoch: snapshot.publicationEpoch,
    snapshotVersion: snapshot.snapshotVersion,
    activeGroupId,
    activeTabId: active?.id ?? null,
    activeTabType: active?.type ?? null,
    ...(tabGroups ? { tabGroups } : {}),
    ...(snapshot.tabGroupLayout !== undefined ? { tabGroupLayout } : {}),
    ...(snapshot.retiredTerminalSurfaces
      ? {
          retiredTerminalSurfaces: snapshot.retiredTerminalSurfaces.filter(
            (retired) =>
              !snapshot.tabs.some(
                (tab) =>
                  tab.type === 'terminal' &&
                  tab.parentTabId === retired.parentTabId &&
                  tab.leafId === retired.leafId
              )
          )
        }
      : {}),
    tabs: normalizedTabs
  }
}
