import { getVisibleWorkspaceHostIdSet } from '@/components/sidebar/worktree-list/listing/visible-worktree-host-scope'
import { getPairedDeviceIdsByEnvironment } from '../../../../shared/workspace-view/workspace-creator-visibility'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { countUnreadFolderRows, countUnreadWorktreesInBucket } from './unread-badge-count'
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

/** Inputs both counts read: which hosts the sidebar shows. */
function sameHostScope(previous: UnreadBadgeCountState, next: UnreadBadgeCountState): boolean {
  return (
    previous.workspaceHostScope === next.workspaceHostScope &&
    previous.visibleWorkspaceHostIds === next.visibleWorkspaceHostIds &&
    previous.settings?.activeRuntimeEnvironmentId === next.settings?.activeRuntimeEnvironmentId &&
    previous.hideWorkspacesFromOtherDevices === next.hideWorkspacesFromOtherDevices
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

type BucketCount = { bucket: readonly Worktree[]; count: number }

/** Subscribe the Dock sync to the badge integer, so raw-map and title churn neither rescans nor rerenders. Each count reuses its cache while its inputs are unchanged; worktrees recount only the repo buckets a write replaced. */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeCountState) => number {
  let previousState: UnreadBadgeCountState | undefined
  let pairings: ReadonlyMap<string, string> | null = null
  const bucketCounts = new Map<string, BucketCount>()
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
    const reposStale = previous === undefined || scopeStale || previous.repos !== state.repos
    const worktreesStale =
      previous === undefined ||
      reposStale ||
      selectWorktreesByRepo(previous) !== selectWorktreesByRepo(state)
    const foldersStale = previous === undefined || scopeStale || !sameFolderInputs(previous, state)
    if (worktreesStale || foldersStale) {
      const visibleHostIds = getVisibleWorkspaceHostIdSet(state)
      const defaultHostId = getSettingsFocusedExecutionHostId(state.settings)
      if (worktreesStale) {
        const scope = {
          repoMap: getIndexedRepoMap(state.repos),
          visibleHostIds,
          defaultHostId,
          hiddenOtherDevicePairings: statePairings
        }
        if (reposStale) {
          bucketCounts.clear()
        }
        const buckets = selectWorktreesByRepo(state)
        let total = 0
        let bucketTotal = 0
        // Why in place: a write replaces only the buckets it touched, so the rest keep their count unallocated.
        for (const repoId in buckets) {
          const bucket = buckets[repoId]!
          bucketTotal += 1
          let cached = bucketCounts.get(repoId)
          if (cached?.bucket !== bucket) {
            cached = { bucket, count: countUnreadWorktreesInBucket(bucket, scope) }
            bucketCounts.set(repoId, cached)
          }
          total += cached.count
        }
        if (bucketCounts.size !== bucketTotal) {
          for (const repoId of bucketCounts.keys()) {
            if (!(repoId in buckets)) {
              bucketCounts.delete(repoId)
            }
          }
        }
        worktreeCount = total
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
