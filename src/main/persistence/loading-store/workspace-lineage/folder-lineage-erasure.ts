import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import {
  type WorkspaceKey,
  folderWorkspaceKey
} from '../../../../shared/workspace/identity/workspace-scope'
import { preserveFolderLineageUncertainty } from '../../../../shared/worktree/lineage/lineage-uncertainty'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'

/** Drops the folder's lineage rows, keeping uncertainty for released children; returns whether any child was released. */
export function removeFolderLineageRows(state: PersistedState, folderWorkspaceId: string): boolean {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  // A cross-store record moves or drops with its child only.
  delete state.crossStoreLineageByChildKey?.[folderKey]
  const rows: Record<string, WorkspaceLineage | undefined> = state.workspaceLineageByChildKey
  let released = false
  for (const childKey in rows) {
    if (rows[childKey]?.parentWorkspaceKey === folderKey) {
      preserveFolderLineageUncertainty(state, childKey)
      delete rows[childKey]
      released = true
    }
  }
  return released
}

/** Drops a child's workspace-row and cross-store lineage, first keeping any folder-edge uncertainty. */
export function releaseChildLineageRows(state: PersistedState, childKey: WorkspaceKey): void {
  preserveFolderLineageUncertainty(state, childKey)
  delete state.workspaceLineageByChildKey[childKey]
  delete state.crossStoreLineageByChildKey?.[childKey]
}
