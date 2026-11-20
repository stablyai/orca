import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { WorkspaceSelectorCandidate } from '../catalog/workspace-selector-candidates'

/** Folder selectors resolve against these folders, as the runtime's workspace selector does. */
export function folderSelectorResolver(folders: readonly FolderWorkspace[]) {
  return async (selector: string): Promise<WorkspaceSelectorCandidate> => {
    const key = selector.startsWith('id:') ? selector.slice(3) : selector
    const folder = folders.find((entry) => folderWorkspaceKey(entry.id) === key)
    if (!folder) {
      throw new Error('selector_not_found')
    }
    return { kind: 'folder', folder, hostId: null }
  }
}
