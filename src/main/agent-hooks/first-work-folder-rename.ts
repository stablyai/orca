// Why: after the first-work branch+display rename, the worktree's on-disk folder
// still carries its creature name (e.g. `cunner`), which is confusing once the
// branch reads `worktree-creation-spinner`. This module aligns the folder with
// the new branch leaf via `git worktree move`, then migrates Orca's path-derived
// worktree identity so meta, tabs, and the live PTY session carry over. It is
// best-effort and local-only — remote/Windows/locked/dest-taken all degrade to
// "folder kept" without disturbing the rename that already succeeded.
import type { GlobalSettings, Repo } from '../../shared/types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../shared/worktree-id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { planWorktreeFolderRename } from '../ipc/worktree-folder-rename-target'

export type FirstWorkFolderRenameDeps = {
  getRepo: (repoId: string) => Repo | undefined
  getSettings: () => GlobalSettings
  /** Re-key all worktreeId-keyed state from the old (path-derived) id to the new. */
  migrateWorktreeIdentity: (oldWorktreeId: string, newWorktreeId: string) => void
  /** Invalidate caches + tell the renderer the worktree's id changed (old->new) so
   *  it re-keys its state instead of treating the rename as a deletion. */
  notifyWorktreeRenamed: (repoId: string, oldWorktreeId: string, newWorktreeId: string) => void
  /** True when the path already exists — git worktree move refuses a taken dest. */
  pathExists: (path: string) => Promise<boolean>
  moveWorktree: (repoPath: string, oldPath: string, newPath: string) => Promise<void>
}

/**
 * Rename a worktree's folder to match its work-derived branch leaf. Returns true
 * only when the folder was actually moved; false (folder kept) for every skip or
 * graceful-degrade case. Throws only on an unexpected git failure mid-move — the
 * caller swallows it so the branch/display rename is never undone.
 */
export async function renameWorktreeFolderOnFirstWork(
  worktreeId: string,
  newLeaf: string,
  deps: FirstWorkFolderRenameDeps
): Promise<boolean> {
  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  // Why: oldWorktreePath feeds an on-disk folder move. Resolve the synthetic
  // `::workspace:<uuid>` suffix to the backing folder; identity is migrated
  // separately via the untouched worktreeId.
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
  // Order: move first (point of no return), then re-key identity synchronously so
  // nothing interleaves before the worktree's state is re-bound to the new id.
  deps.migrateWorktreeIdentity(worktreeId, plan.newWorktreeId)
  deps.notifyWorktreeRenamed(repo.id, worktreeId, plan.newWorktreeId)
  return true
}
