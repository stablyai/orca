import { normalizeMobileSessionTabSelection } from '../../session-tabs/mobile-session-tab-selection'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-session-contracts'
import { dropRetirementProofsForLiveSurfaces } from '../../../../shared/workspace-layout/terminal-retirement-proof-ledger'
import { orderMobileSessionTabsByGroups } from './mobile-session-tab-merge'
import type {
  RuntimeMobileSessionProjectionHost,
  RuntimeMobileSessionProjectionInput
} from './runtime-mobile-session-projection-contract'

export function finalizeRuntimeMobileSessionTabsResult(
  { snapshot, tabs }: RuntimeMobileSessionProjectionInput,
  host: Pick<
    RuntimeMobileSessionProjectionHost,
    'sanitizeGroups' | 'pruneGroupLayout' | 'collectTabIds'
  >
): RuntimeMobileSessionTabsResult {
  const normalized = normalizeMobileSessionTabSelection({ ...snapshot, tabs })
  const active = normalized.tabs.find((tab) => tab.isActive) ?? null
  const normalizedTabs = normalized.tabs
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
          retiredTerminalSurfaces: dropRetirementProofsForLiveSurfaces(
            snapshot.retiredTerminalSurfaces,
            snapshot.tabs
          )
        }
      : {}),
    // Follow group order: merged runtime-kept chat tabs otherwise append to clients' visible strip.
    tabs: tabGroups
      ? orderMobileSessionTabsByGroups(normalizedTabs, tabGroups, tabGroupLayout)
      : normalizedTabs
  }
}
