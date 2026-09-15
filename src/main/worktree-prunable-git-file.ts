import { isENOENT } from './ipc/filesystem-path-containment'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import { getLocalWorktreePathAccess, toLocalWorktreeRuntimePath } from './local-worktree-filesystem'

/** Registration cleanup must never reinterpret a malformed .git row as its parent checkout. */
export async function isPrunableGitFileWorktree(
  worktree: GitWorktreeInfo,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<boolean> {
  if (
    worktree.prunable !== true ||
    worktree.isMainWorktree ||
    worktree.isBare ||
    worktree.locked ||
    !worktree.branch.startsWith('refs/heads/') ||
    worktree.branch === 'refs/heads/' ||
    !worktree.head ||
    worktree.path.split(/[\\/]/).at(-1) !== '.git'
  ) {
    return false
  }

  const access = getLocalWorktreePathAccess(options)

  const entry = await access
    .statPath(toLocalWorktreeRuntimePath(worktree.path, options))
    .catch((error: unknown) => {
      // A vanished marker leaves missing-path recovery to its existing stricter gate.
      if (isENOENT(error)) {
        return null
      }

      throw error
    })

  if (!entry || typeof entry !== 'object') {
    return false
  }

  // WSL returns the owning guest's lstat-equivalent type; native lstat rejects symlinks too.
  return (
    ('type' in entry && entry.type === 'file') ||
    ('isFile' in entry && typeof entry.isFile === 'function' && entry.isFile() === true)
  )
}
