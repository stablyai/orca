import {
  ALL_EXECUTION_HOSTS_SCOPE,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { getHostContextLabel } from '../../../src/shared/worktree/host-context-labels'
import type { DesktopSidebarFacts } from '../../../src/shared/sidebar-list/desktop-sidebar-facts'
import type { ProjectGroup } from '../../../src/shared/project-group-types'
import type { Repo } from '../../../src/shared/repo-types'
import type {
  SidebarFeedCatalog,
  SidebarFeedView
} from '../../../src/shared/sidebar-list/sidebar-feed-rows'
import type { ProjectOrderBy } from '../../../src/shared/ui-chrome-types'
import type { ServedProjectSections } from '../worktree/project-sections-operations'
import type { MobileViewState } from '../worktree/workspace-view-settings'
import type { SectionRepo } from '../worktree/workspace-list-types'

/**
 * The view the desktop's sidebar shows, from the shared UI state and settings this phone mirrors.
 * The host list is passed resolved with an "all" scope, which every builder step reads the same
 * as the desktop's legacy scope.
 */
export function buildHostFeedView(args: {
  view: MobileViewState
  projectOrderBy: ProjectOrderBy
  /** The feed's desktop facts: its focused host, its names for its hosts, pinned placement. */
  desktop: DesktopSidebarFacts | null
  /** The desktop's platform names its own host; the phone's must never. */
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

function catalogRepo(repo: SectionRepo): Repo {
  return {
    id: repo.id,
    path: repo.path,
    displayName: repo.displayName,
    badgeColor: repo.badgeColor ?? '',
    addedAt: repo.addedAt ?? 0,
    ...(repo.connectionId !== undefined ? { connectionId: repo.connectionId } : {}),
    ...(repo.executionHostId ? { executionHostId: repo.executionHostId } : {})
  }
}

/**
 * The catalog the feed does not carry: the one the desktop window publishes (every host, paired
 * servers included), or on a host with no window its own repos and project groups.
 */
export function buildHostFeedCatalog(
  served: ServedProjectSections | null,
  hostRepos: readonly SectionRepo[],
  hostProjectGroups: readonly ProjectGroup[]
): SidebarFeedCatalog {
  return served
    ? {
        repos: served.repos.map(catalogRepo),
        projectGroups: served.projectGroups ?? hostProjectGroups,
        projectGrouping: { projects: served.projects, projectHostSetups: served.setups }
      }
    : {
        repos: hostRepos.map(catalogRepo),
        projectGroups: hostProjectGroups,
        projectGrouping: { projects: [], projectHostSetups: [] }
      }
}
