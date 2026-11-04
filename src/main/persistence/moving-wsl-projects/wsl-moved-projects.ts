/**
 * The local projects a WSL host now owns, as the desktop lists them: read-only entries whose
 * existing chats stay on this computer (owner decision, option C). Separate from the repo and
 * folder lists so no caller can mistake one for a normal, editable project.
 */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'
import type { WslMovedProject } from '../../../shared/wsl-move/wsl-moved-project'
import { isLocalWslMoveRow, wslMoveHostDistro } from './wsl-move-scope-guard'

type MovedRepoRow = Pick<Repo, 'id' | 'displayName' | 'path' | 'connectionId' | 'executionHostId'>
type MovedFolderRow = Pick<
  FolderWorkspace,
  'id' | 'name' | 'folderPath' | 'connectionId' | 'executionHostId'
>

export function listWslMovedProjects(
  repos: readonly MovedRepoRow[],
  folderWorkspaces: readonly MovedFolderRow[]
): WslMovedProject[] {
  const moved: WslMovedProject[] = []
  for (const repo of repos) {
    const distro = isLocalWslMoveRow(repo) ? wslMoveHostDistro({ repoId: repo.id }) : null
    if (distro) {
      const { id, displayName, path } = repo
      moved.push({ kind: 'repo', id, displayName, path, distro })
    }
  }
  for (const folder of folderWorkspaces) {
    const distro = isLocalWslMoveRow(folder)
      ? wslMoveHostDistro({ folderWorkspaceId: folder.id })
      : null
    if (distro) {
      const { id, name, folderPath } = folder
      moved.push({ kind: 'folder', id, displayName: name, path: folderPath, distro })
    }
  }
  return moved
}
