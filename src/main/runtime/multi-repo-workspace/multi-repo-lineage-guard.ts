import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { WorktreeLineageResolution } from '../runtime-worktree-lineage-resolution'
import type { RuntimeStore } from '../runtime-store-contract'
import { recordCreatedWorktreeLineage } from '../runtime-worktree-lineage-recording'

function isMultiRepoFolderParentKey(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'>,
  parentWorkspaceKey: string
): boolean {
  return (store.getFolderWorkspaces?.() ?? []).some(
    (workspace) =>
      workspace.multiRepo !== undefined && folderWorkspaceKey(workspace.id) === parentWorkspaceKey
  )
}

/** Only the orchestrator attaches members; any other create under a multi-repo parent is created standalone. */
function withoutMultiRepoParent(
  store: Pick<RuntimeStore, 'getFolderWorkspaces'> | null,
  resolution: WorktreeLineageResolution
): WorktreeLineageResolution {
  if (
    !store ||
    resolution.kind !== 'lineage' ||
    resolution.parent.type !== 'folder' ||
    !isMultiRepoFolderParentKey(store, resolution.parent.workspaceKey)
  ) {
    return resolution
  }
  return {
    kind: 'none',
    warnings: [
      {
        code: 'LINEAGE_PARENT_CONTEXT_CONFLICT',
        message:
          'Created without a parent: projects are added to a multi-repo workspace only when it is created.'
      }
    ]
  }
}

export function recordLineageOutsideMultiRepoParent(
  store: RuntimeStore | null,
  worktree: Parameters<typeof recordCreatedWorktreeLineage>[1],
  resolution: WorktreeLineageResolution
): ReturnType<typeof recordCreatedWorktreeLineage> {
  return recordCreatedWorktreeLineage(store, worktree, withoutMultiRepoParent(store, resolution))
}
