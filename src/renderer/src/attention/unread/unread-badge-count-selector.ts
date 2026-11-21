import { getVisibleWorkspaceHostIdSet } from '@/components/sidebar/worktree-list/listing/visible-worktree-host-scope'
import { getPairedDeviceIdsByEnvironment } from '../../../../shared/workspace-view/workspace-creator-visibility'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import { sameBucketRecords } from './unread-bucket-record-equality'
import { getUnreadBadgeCount } from './unread-badge-count'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

type UnreadBadgeCountState = Pick<
  AppState,
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'workspaceHostScope'
  | 'visibleWorkspaceHostIds'
  | 'hideWorkspacesFromOtherDevices'
  | 'runtimeEnvironments'
  | 'runtimeStatusByEnvironmentId'
>

/** The worktree fields the count reads (`id` embeds `repoId`), so equality over them is a sound cache key. */
function sameBadgeWorktree(previous: Worktree, next: Worktree): boolean {
  const previousCreator = previous.creatorProvenance
  const nextCreator = next.creatorProvenance
  return (
    previous.runtimeOwnerEnvironmentId === next.runtimeOwnerEnvironmentId &&
    previousCreator?.kind === nextCreator?.kind &&
    (previousCreator?.kind !== 'paired-device' ||
      (nextCreator?.kind === 'paired-device' &&
        previousCreator.deviceId === nextCreator.deviceId)) &&
    previous.id === next.id &&
    previous.hostId === next.hostId &&
    previous.isUnread === next.isUnread &&
    previous.isArchived === next.isArchived
  )
}

function sameCountInputs(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  return (
    selectFolderWorkspaces(previous) === selectFolderWorkspaces(next) &&
    previous.projectGroups === next.projectGroups &&
    previous.repos === next.repos &&
    previous.workspaceHostScope === next.workspaceHostScope &&
    previous.visibleWorkspaceHostIds === next.visibleWorkspaceHostIds &&
    previous.settings?.activeRuntimeEnvironmentId === next.settings?.activeRuntimeEnvironmentId &&
    previous.hideWorkspacesFromOtherDevices === next.hideWorkspacesFromOtherDevices &&
    sameBucketRecords(
      selectWorktreesByRepo(previous),
      selectWorktreesByRepo(next),
      sameBadgeWorktree
    )
  )
}

function samePairings(
  previous: ReadonlyMap<string, string> | null,
  next: ReadonlyMap<string, string> | null
): boolean {
  if (previous === next) {
    return true
  }
  if (!previous || !next || previous.size !== next.size) {
    return false
  }
  for (const [environmentId, deviceId] of next) {
    if (previous.get(environmentId) !== deviceId) {
      return false
    }
  }
  return true
}

/** Subscribe the Dock sync to the badge integer, so raw-map and title churn neither rescans nor rerenders. Compare each state's read set to its predecessor; transitive equality preserves the cached count across unchanged runs. */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeCountState) => number {
  let previousState: UnreadBadgeCountState | undefined
  let pairings: ReadonlyMap<string, string> | null = null
  let unreadCount = 0

  // Why by content: runtime status reallocates on every remote status write, but only device ids filter rows.
  const nextPairings = (state: UnreadBadgeCountState): ReadonlyMap<string, string> | null => {
    if (!state.hideWorkspacesFromOtherDevices) {
      return null
    }
    if (
      pairings &&
      previousState?.hideWorkspacesFromOtherDevices &&
      previousState.runtimeEnvironments === state.runtimeEnvironments &&
      previousState.runtimeStatusByEnvironmentId === state.runtimeStatusByEnvironmentId
    ) {
      return pairings
    }
    return getPairedDeviceIdsByEnvironment(
      state.runtimeEnvironments,
      state.runtimeStatusByEnvironmentId
    )
  }

  return (state) => {
    const statePairings = nextPairings(state)
    if (
      !previousState ||
      !samePairings(pairings, statePairings) ||
      !sameCountInputs(previousState, state)
    ) {
      unreadCount = getUnreadBadgeCount({
        worktreeBuckets: selectWorktreesByRepo(state),
        folders: selectFolderWorkspaces(state),
        projectGroups: state.projectGroups,
        repoMap: getIndexedRepoMap(state.repos),
        visibleHostIds: getVisibleWorkspaceHostIdSet(state),
        defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
        hiddenOtherDevicePairings: statePairings
      })
      pairings = statePairings
    }
    previousState = state
    return unreadCount
  }
}
