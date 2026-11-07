import type { Repo } from '../../shared/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree/id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { planWorktreeFolderRename } from '../ipc/worktree-folder-rename-target'
import { hostWorktreeTargetForRepo } from '../persistence/host-qualified-worktree-meta'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

export type FirstWorkFolderRenameDeps = {
  getRepo: (repoId: string) => Repo | undefined
  getSettings: () => Parameters<typeof planWorktreeFolderRename>[0]['settings']
  migrateWorktreeIdentity: (target: HostWorktreeTarget, newWorktreeId: string) => void
  /** Re-key renderer state so a folder move is not treated as deletion. */
  notifyWorktreeRenamed: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
  pathExists: (path: string) => Promise<boolean>
  moveWorktree: (repoPath: string, oldPath: string, newPath: string) => Promise<void>
}

/** False keeps the folder; callers retain the successful branch rename even if this move fails. */
export async function renameWorktreeFolderOnFirstWork(
  worktreeId: string,
  newLeaf: string,
  deps: FirstWorkFolderRenameDeps
): Promise<boolean> {
  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  // Strip synthetic workspace suffixes from filesystem paths without losing the identity suffix.
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!repo || !parsed) {
    return false
  }
  const plan = planWorktreeFolderRename({
    repoId: repo.id,
    repoPath: repo.path,
    oldWorktreePath: parsed.worktreePath,
    worktreeIdSuffix: worktreeId.includes(FOLDER_WORKSPACE_INSTANCE_SEPARATOR)
      ? `${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${worktreeId.split(FOLDER_WORKSPACE_INSTANCE_SEPARATOR).at(-1)}`
      : undefined,
    newLeaf,
    settings: deps.getSettings(),
    platform: process.platform,
    isRemote: getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
  })
  if (!plan) {
    return false
  }
  if (await deps.pathExists(plan.newPath)) {
    return false
  }
  await deps.moveWorktree(repo.path, plan.oldPath, plan.newPath)
  // After the move, migrate identity synchronously before notifying the renderer.
  deps.migrateWorktreeIdentity(hostWorktreeTargetForRepo(worktreeId, repo), plan.newWorktreeId)
  deps.notifyWorktreeRenamed(repo.id, worktreeId, plan.newWorktreeId)
  return true
}
