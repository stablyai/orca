import {
  prepareLocalWorktreeFilesystem,
  type LocalWorktreeFilesystem,
  type LocalWorktreeFilesystemOptions
} from '../../../workspaces/removal/local-worktree-filesystem'
import { isWorktreePathMissing } from '../../../workspaces/removal/worktree-removal-safety'

export async function isAlreadyRemovedWorktreePath(
  worktreePath: string,
  localWorktreeGitOptions: LocalWorktreeFilesystemOptions = {},
  filesystem?: LocalWorktreeFilesystem
): Promise<boolean> {
  const scope =
    filesystem ?? (await prepareLocalWorktreeFilesystem([worktreePath], localWorktreeGitOptions))
  const missing = await isWorktreePathMissing(
    scope.runtimePath(worktreePath),
    scope.access.statPath
  )
  scope.assertCurrent()
  return missing
}
