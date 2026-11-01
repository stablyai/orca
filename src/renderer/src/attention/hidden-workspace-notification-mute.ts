import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { ALL_EXECUTION_HOSTS_SCOPE } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { sidebarHasActiveFilters } from '@/components/sidebar/sidebar-filter-actions'
import { computeVisibleWorktreeIds } from '@/components/sidebar/compute-visible-worktrees'
import { buildVisibleWorktreeOptionsFromState } from '@/components/sidebar/visible-worktree-options-from-state'
import { isFolderWorkspaceFromOtherDevice } from '../../../shared/workspace-creator-visibility'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

/** Apply sidebar kind filters with project/host filters lifted so lineage and host twins follow sidebar visibility. Muting suppresses unread/banner/sound/push.
 * Fail open until settings/UI and terminal reconnect hydrate, or when the workspace is unknown; restored rows otherwise look asleep. */
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
    const folder = selectFolderWorkspaces(state).find((item) => item.id === scope.folderWorkspaceId)
    return (
      folder !== undefined &&
      inputs.hideWorkspacesFromOtherDevices &&
      isFolderWorkspaceFromOtherDevice(folder, inputs.pairedDeviceIdsByEnvironment)
    )
  }
  const known = getIndexedAllWorktrees(selectWorktreesByRepo(state)).some(
    (worktree) => worktree.id === workspaceId && !worktree.isArchived
  )
  if (!known) {
    return false
  }
  // Use the full sidebar pass (~0.2–0.3ms/1,000 workspaces) to preserve every rule that adds rows back.
  const visibleIds = computeVisibleWorktreeIds(selectWorktreesByRepo(state), [], {
    ...inputs,
    filterRepoIds: [],
    workspaceHostScope: ALL_EXECUTION_HOSTS_SCOPE,
    visibleWorkspaceHostIds: null
  })
  return !visibleIds.includes(workspaceId)
}
