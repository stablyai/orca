import type { WorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { preserveFolderLineageUncertainty } from '../../../../shared/worktree/lineage/lineage-uncertainty'
import type { PersistedState } from '../../../../shared/persisted-state-types'

export function removeFolderLineageRows(state: PersistedState, folderWorkspaceId: string): void {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  delete state.crossStoreLineageByChildKey?.[folderKey]
  const rows: Record<string, WorkspaceLineage | undefined> = state.workspaceLineageByChildKey
  for (const childKey in rows) {
    if (rows[childKey]?.parentWorkspaceKey === folderKey) {
      preserveFolderLineageUncertainty(state, childKey)
      delete rows[childKey]
    }
  }
}
