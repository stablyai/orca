import type { WorktreeLineage, WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey,
  type WorkspaceKey
} from '../../../shared/workspace-scope'
import type { StoreRuntimeState } from './store-runtime-state'
import {
  createLineageProjectLookup,
  getWorkspaceLineagePolicy,
  projectLineageAllowed
} from '../../../shared/workspace-lineage-policy'
import { toWorkspaceLineageRow } from '../../../shared/worktree/worktree-lineage-workspace-row'
import { folderParentDefeatsInferredParent } from './folder-parent-lineage-persistence'

export function projectWorktreeLineage(
  state: StoreRuntimeState['state'],
  worktreeId: string
): WorktreeLineage | undefined {
  const row = state.worktreeLineageById[worktreeId]
  if (
    folderParentDefeatsInferredParent(
      row,
      state.workspaceLineageByChildKey[worktreeWorkspaceKey(worktreeId)]
    )
  ) {
    return undefined
  }
  return row && projectLineageAllowed(state, toWorkspaceLineageRow(row)) ? row : undefined
}

export function projectAllWorktreeLineage(
  state: StoreRuntimeState['state']
): Record<string, WorktreeLineage> {
  const restricted = getWorkspaceLineagePolicy(state.settings) === 'same-project'
  const lookup = restricted ? createLineageProjectLookup(state) : undefined
  const rows = Object.entries(state.worktreeLineageById)
  const projected = rows.filter(
    ([id, row]) =>
      !folderParentDefeatsInferredParent(
        row,
        state.workspaceLineageByChildKey[worktreeWorkspaceKey(id)]
      ) &&
      (!restricted || projectLineageAllowed(state, toWorkspaceLineageRow(row), lookup))
  )
  return projected.length === rows.length
    ? state.worktreeLineageById
    : Object.fromEntries(projected)
}

export function projectAllWorkspaceLineage(
  state: StoreRuntimeState['state']
): Record<WorkspaceKey, WorkspaceLineage> {
  if (getWorkspaceLineagePolicy(state.settings) !== 'same-project') {
    return state.workspaceLineageByChildKey
  }
  const lookup = createLineageProjectLookup(state)
  return Object.fromEntries(
    Object.entries(state.workspaceLineageByChildKey).filter(([, row]) =>
      projectLineageAllowed(state, row, lookup)
    )
  )
}

export function removeFolderLineageRows(
  state: StoreRuntimeState['state'],
  folderWorkspaceId: string
): void {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  // A cross-store record moves or drops with its child only.
  delete state.crossStoreLineageByChildKey?.[folderKey]
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    if (lineage.parentWorkspaceKey === folderKey) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
    }
  }
}
