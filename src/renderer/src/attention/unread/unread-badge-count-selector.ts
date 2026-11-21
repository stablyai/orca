import { getVisibleWorkspaceHostIdSet } from '@/components/sidebar/worktree-list/listing/visible-worktree-host-scope'
import { getPairedDeviceIdsByEnvironment } from '../../../../shared/workspace-view/workspace-creator-visibility'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { sameBucketRecords } from './unread-bucket-record-equality'
import { countUnreadFolderRows, countUnreadWorktrees } from './unread-badge-count'
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

/** Inputs both counts read: which hosts the sidebar shows. */
function sameHostScope(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  return (
    previous.workspaceHostScope === next.workspaceHostScope &&
    previous.visibleWorkspaceHostIds === next.visibleWorkspaceHostIds &&
    previous.settings?.activeRuntimeEnvironmentId === next.settings?.activeRuntimeEnvironmentId &&
    previous.hideWorkspacesFromOtherDevices === next.hideWorkspacesFromOtherDevices
  )
}

function sameWorktreeInputs(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  return (
    previous.repos === next.repos &&
    sameBucketRecords(
      selectWorktreesByRepo(previous),
      selectWorktreesByRepo(next),
      sameBadgeWorktree
    )
  )
}

/** The folder fields the count reads; activity timestamps and names are not among them. */
function sameBadgeFolder(previous: FolderWorkspace, next: FolderWorkspace): boolean {
  return (
    previous === next ||
    (previous.id === next.id &&
      previous.isUnread === next.isUnread &&
      previous.projectGroupId === next.projectGroupId &&
      previous.executionHostId === next.executionHostId &&
      previous.connectionId === next.connectionId &&
      previous.creatorProvenance?.kind === next.creatorProvenance?.kind &&
      (previous.creatorProvenance?.kind !== 'paired-device' ||
        (next.creatorProvenance?.kind === 'paired-device' &&
          previous.creatorProvenance.deviceId === next.creatorProvenance.deviceId)))
  )
}

function sameFolderInputs(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  const previousFolders = selectFolderWorkspaces(previous)
  const nextFolders = selectFolderWorkspaces(next)
  return (
    previous.projectGroups === next.projectGroups &&
    (previousFolders === nextFolders ||
      (previousFolders.length === nextFolders.length &&
        nextFolders.every((folder, index) => sameBadgeFolder(previousFolders[index]!, folder))))
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
  let worktreeCount = 0
  let folderCount = 0

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
    const previous = previousState
    const statePairings = nextPairings(state)
    const scopeStale =
      previous === undefined ||
      !samePairings(pairings, statePairings) ||
      !sameHostScope(previous, state)
    // Why two caches: folder activity writes replace the folder list without touching worktree rows.
    const worktreesStale = scopeStale || !sameWorktreeInputs(previous, state)
    const foldersStale = scopeStale || !sameFolderInputs(previous, state)
    if (worktreesStale || foldersStale) {
      const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
      const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
      if (worktreesStale) {
        worktreeCount = countUnreadWorktrees({
          worktreeBuckets: selectWorktreesByRepo(state),
          repoMap: getIndexedRepoMap(state.repos),
          visibleHostIds,
          defaultHostId,
          hiddenOtherDevicePairings: statePairings
        })
      }
      if (foldersStale) {
        folderCount = countUnreadFolderRows({
          folders: selectFolderWorkspaces(state),
          projectGroups: state.projectGroups,
          visibleHostIds,
          defaultHostId,
          hiddenOtherDevicePairings: statePairings
        })
      }
      pairings = statePairings
    }
    previousState = state
    return worktreeCount + folderCount
  }
}
