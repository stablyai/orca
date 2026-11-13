import { isENOENT } from '../../ipc/filesystem/access/filesystem-path-containment'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'

import {
  type LocalWorktreeFilesystemOptions,
  prepareLocalWorktreeFilesystem
} from './local-worktree-filesystem'

/** Malformed .git paths must never resolve cleanup to a parent checkout. */
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
  const filesystem = await prepareLocalWorktreeFilesystem([worktree.path], options)
  const entry = await filesystem.access
    .statPath(filesystem.runtimePath(worktree.path))
    .catch((error: unknown) => {
      // A vanished marker leaves missing-path recovery to its existing stricter gate.
      if (isENOENT(error)) {
        return null
      }
      throw error
    })
  filesystem.assertCurrent()
  if (!entry || typeof entry !== 'object') {
    return false
  }
  // WSL returns the owning guest's lstat-equivalent type; native lstat rejects symlinks too.
  return (
    ('type' in entry && entry.type === 'file') ||
    ('isFile' in entry && typeof entry.isFile === 'function' && entry.isFile() === true)
  )
}
