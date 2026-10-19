import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'

/**
 * Whether attention from this workspace must raise nothing — no unread, banner, sound or push —
 * because a Filters-menu switch hides it and "Notify About Hidden Workspaces" is off.
 *
 * Asks the sidebar pipeline itself with the project and host filters lifted, so lineage parents
 * and same-id rows on other hosts notify exactly when the sidebar would show them.
 * Fails open: unhydrated settings or UI state, terminals not yet reconnected (every restored
 * workspace would read as sleeping), or a workspace this store has no record of, notify.
 */
export function isWorkspaceNotificationMutedBySidebarFilters(
  state: AppState,
  workspaceId: string
): boolean {
  if (
    state.settings?.notifications?.notifyHiddenWorkspaces !== false ||
    !state.persistedUIReady ||
    !state.workspaceSessionReady ||
    !sidebarHasActiveFilters(state)
  ) {
    return false
  }
  const repoMap = getIndexedRepoMap(state.repos)
  const inputs = buildVisibleWorktreeOptionsFromState(state, repoMap)
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((item) => item.id === scope.folderWorkspaceId)
    return (
      folder !== undefined &&
      inputs.hideWorkspacesFromOtherDevices &&
      isFolderWorkspaceFromOtherDevice(folder, inputs.pairedDeviceIdsByEnvironment)
    )
  }
  const known = getIndexedAllWorktrees(state.worktreesByRepo).some(
    (worktree) => worktree.id === workspaceId && !worktree.isArchived
  )
  if (!known) {
    return false
  }
  // Why the full sidebar pass per call: measured at ~0.2-0.3 ms with 1,000 workspaces, and a
  // per-row shortcut would have to mirror every way the sidebar adds rows back.
  const visibleIds = computeVisibleWorktreeIds(state.worktreesByRepo, [], {
    ...inputs,
    filterRepoIds: [],
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: null
  })
  return !visibleIds.includes(workspaceId)
}
