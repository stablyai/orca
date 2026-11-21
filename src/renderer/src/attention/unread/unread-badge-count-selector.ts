import { getVisibleWorkspaceHostIdSet } from '@/components/sidebar/worktree-list/listing/visible-worktree-host-scope'
import { getPairedDeviceIdsByEnvironment } from '../../../../shared/workspace-view/workspace-creator-visibility'
import { getIndexedRepoMap } from '@/store/repos/repository-catalog-index'
import type { AppState } from '@/store/types'
import { getSettingsFocusedExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { sameBucketRecords } from './unread-bucket-record-equality'
import { getUnreadBadgeCount } from './unread-badge-count'
import { workspaceHasLiveMarker } from '@/store/slices/workspace-attention/workspace-live-markers'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
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
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
  | 'unreadAgentCompletionPanes'
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

const unreadFoldersCache = new WeakMap<readonly FolderWorkspace[], readonly FolderWorkspace[]>()

function unreadFolders(folders: readonly FolderWorkspace[]): readonly FolderWorkspace[] {
  let unread = unreadFoldersCache.get(folders)
  if (!unread) {
    unread = folders.filter((folder) => folder.isUnread)
    unreadFoldersCache.set(folders, unread)
  }
  return unread
}

function sameFolderAttention(
  previous: UnreadBadgeCountState,
  next: UnreadBadgeCountState
): boolean {
  const sameMarkers =
    previous.unreadTerminalTabs === next.unreadTerminalTabs &&
    previous.unreadAgentCompletionPanes === next.unreadAgentCompletionPanes
  if (
    sameMarkers &&
    previous.tabsByWorktree === next.tabsByWorktree &&
    previous.unifiedTabsByWorktree === next.unifiedTabsByWorktree
  ) {
    return true
  }
  for (const folder of unreadFolders(selectFolderWorkspaces(next))) {
    const key = folderWorkspaceKey(folder.id)
    // Why: title batches replace the tab maps but keep other workspaces' buckets.
    if (
      sameMarkers &&
      previous.tabsByWorktree[key] === next.tabsByWorktree[key] &&
      previous.unifiedTabsByWorktree[key] === next.unifiedTabsByWorktree[key]
    ) {
      continue
    }
    if (workspaceHasLiveMarker(previous, key) !== workspaceHasLiveMarker(next, key)) {
      return false
    }
  }
  return true
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
    // Why gated: runtime status reallocates on remote activity and only this filter reads it.
    (!next.hideWorkspacesFromOtherDevices ||
      (previous.runtimeEnvironments === next.runtimeEnvironments &&
        previous.runtimeStatusByEnvironmentId === next.runtimeStatusByEnvironmentId)) &&
    sameBucketRecords(
      selectWorktreesByRepo(previous),
      selectWorktreesByRepo(next),
      sameBadgeWorktree
    ) &&
    sameFolderAttention(previous, next)
  )
}

/** Subscribe App to the badge integer, avoiding whole-shell rerenders on raw-map/title churn. Compare each state’s read set to its predecessor; transitive equality preserves the cached count across unchanged runs. */
export function createUnreadBadgeCountSelector(): (state: UnreadBadgeCountState) => number {
  let previousState: UnreadBadgeCountState | undefined
  let unreadCount = 0

  return (state) => {
    if (!previousState || !sameCountInputs(previousState, state)) {
      unreadCount = getUnreadBadgeCount({
        worktreeBuckets: selectWorktreesByRepo(state),
        folders: selectFolderWorkspaces(state),
        tabsByWorktree: state.tabsByWorktree,
        unifiedTabsByWorktree: state.unifiedTabsByWorktree,
        unreadTerminalTabs: state.unreadTerminalTabs,
        unreadAgentCompletionPanes: state.unreadAgentCompletionPanes,
        projectGroups: state.projectGroups,
        repoMap: getIndexedRepoMap(state.repos),
        visibleHostIds: getVisibleWorkspaceHostIdSet(state),
        defaultHostId: getSettingsFocusedExecutionHostId(state.settings),
        hiddenOtherDevicePairings: state.hideWorkspacesFromOtherDevices
          ? getPairedDeviceIdsByEnvironment(
              state.runtimeEnvironments,
              state.runtimeStatusByEnvironmentId
            )
          : null
      })
    }
    previousState = state
    return unreadCount
  }
}
