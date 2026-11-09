import type { WorktreeLineage, WorkspaceLineage } from '../../../shared/worktree/lineage-types'
import { folderWorkspaceKey, type WorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreRuntimeState } from './store-runtime-state'
import {
  createLineageProjectLookup,
  getWorkspaceLineagePolicy,
  projectLineageAllowed
} from '../../../shared/workspace-lineage-policy'
import { toWorkspaceLineageRow } from '../../../shared/worktree/worktree-lineage-workspace-row'

export function projectAllWorktreeLineage(
  state: StoreRuntimeState['state']
): Record<string, WorktreeLineage> {
  if (getWorkspaceLineagePolicy(state.settings) !== 'same-project') {
    return state.worktreeLineageById
  }
  const lookup = createLineageProjectLookup(state)
  return Object.fromEntries(
    Object.entries(state.worktreeLineageById).filter(([, row]) =>
      projectLineageAllowed(state, toWorkspaceLineageRow(row), lookup)
    )
  )
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
