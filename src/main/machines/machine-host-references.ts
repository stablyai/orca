import { getRepoExecutionHostId, toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'

type ProjectSource = {
  getRepos(): Pick<Repo, 'connectionId' | 'executionHostId'>[]
  getFolderWorkspaces(): Pick<FolderWorkspace, 'connectionId' | 'executionHostId'>[]
}

/**
 * Whether anything on this desktop still runs on an execution host, which keeps a gone machine's
 * row as its worktrees' Gone link. A saved runtime environment counts on its own: a machine's
 * worktrees live in its managed server's catalog, not in this desktop's project list.
 */
export function isMachineHostReferenced(
  projects: ProjectSource,
  savedEnvironmentIds: () => readonly string[],
  hostId: string
): boolean {
  return (
    [...projects.getRepos(), ...projects.getFolderWorkspaces()].some(
      (project) => getRepoExecutionHostId(project) === hostId
    ) || savedEnvironmentIds().some((id) => toRuntimeExecutionHostId(id) === hostId)
  )
}
