import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'
import type { DesktopSidebarFacts } from '../../../src/shared/sidebar-list/desktop-sidebar-facts'
import type { SidebarFeedView } from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { MobileViewState } from '../worktree/workspace-view-settings'

// Mirror desktop UI/settings into the shared sidebar builder; resolved all-host scope matches desktop legacy scope.
export function buildHostFeedView(args: {
  view: MobileViewState
  projectOrderBy: ProjectOrderBy
  desktop: DesktopSidebarFacts | null
  hostPlatform: NodeJS.Platform | null
}): SidebarFeedView {
  const { view, desktop, hostPlatform } = args
  const hostLabelOverrides = new Map<ExecutionHostId, string>(
    Object.entries(desktop?.hostLabels ?? {}).flatMap(([hostId, label]) => {
      const id = normalizeExecutionHostId(hostId)
      return id ? [[id, label] as const] : []
    })
  )
  return {
    groupBy: view.groupBy,
    sortBy: view.sortBy,
    projectOrderBy: args.projectOrderBy,
    collapsedGroups: new Set(view.collapsedGroups),
    filters: view.filters,
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: view.filters.visibleHostIds,
    workspaceStatuses: view.workspaceStatuses,
    pinnedDisplayPolicy: desktop?.showPinnedInGroups ? 'duplicate-in-groups' : 'single-location',
    defaultHostId: normalizeExecutionHostId(desktop?.focusedHostId) ?? LOCAL_EXECUTION_HOST_ID,
    hostLabelOverrides,
    // Null platform names no OS ("This computer"); the phone's own never stands in for it.
    localHostLabel: getHostContextLabel(LOCAL_EXECUTION_HOST_ID, { hostPlatform })
  }
}
