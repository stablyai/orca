import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../shared/folder-workspace-execution-host'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

export function getVerifiedLocalFolderWorkspaceKeys(state: FolderWorkspaceHostState): Set<string> {
  const counts = new Map<string, number>()
  for (const workspace of state.folderWorkspaces) {
    counts.set(workspace.id, (counts.get(workspace.id) ?? 0) + 1)
  }
  const keys = new Set<string>()
  for (const workspace of state.folderWorkspaces) {
    if (counts.get(workspace.id) !== 1) {
      continue
    }
    const pin = parseExecutionHostId(workspace.executionHostId)
    if (workspace.executionHostId != null) {
      if (pin?.kind === 'local') {
        keys.add(folderWorkspaceKey(workspace.id))
      }
      continue
    }
    if (resolveFolderWorkspaceHost(state, workspace.id).kind !== 'local') {
      continue
    }
    // The shared legacy resolver projects runtime ownership as local; attribution cannot.
    if (
      findFolderWorkspaceCandidateRepos(state, workspace.id).some(
        (repo) => getRepoExecutionHostId(repo) !== 'local'
      )
    ) {
      continue
    }
    keys.add(folderWorkspaceKey(workspace.id))
  }
  return keys
}
