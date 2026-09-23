import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'

// Why this is a leaf module rather than part of ipc/worktree-symlinks: status
// and review-creation need only the read-only "is this a symlink" question, and
// importing the materialization module would pull APFS cloning — and its
// child_process dependency — into their graph.

export type SafeRelativePathResult = { safe: true; rel: string } | { safe: false }

// Drive-relative paths (C:foo) must also stay outside repository-relative input.
const WINDOWS_DRIVE_DESIGNATOR = /^[a-zA-Z]:/

export function getSafeRelativePath(rawPath: string): SafeRelativePathResult {
  const parts = rawPath
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.')
  if (!parts[0] || WINDOWS_DRIVE_DESIGNATOR.test(parts[0]) || parts.includes('..')) {
    return { safe: false }
  }
  return { safe: true, rel: parts.join('/') }
}

export type WorktreeSymlinkDetectionOptions = {
  /** Distro that spelled `worktreePath`, for a Windows host reopening a guest path. */
  wslDistro?: string
}

export async function findExistingWorktreeSymlinkPaths(
  worktreePath: string,
  paths: readonly string[],
  options: WorktreeSymlinkDetectionOptions = {}
): Promise<string[]> {
  // Why: git in a WSL distro reports the worktree in the guest namespace, but this lstat runs in
  // the Windows main process, where that spelling names nothing.
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options) ?? worktreePath
  const symlinkPaths: string[] = []
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    try {
      if ((await lstat(resolve(hostWorktreePath, safePath.rel))).isSymbolicLink()) {
        symlinkPaths.push(safePath.rel)
      }
    } catch {
      // Why: only a positively identified symlink may bypass dirty preflight.
    }
  }
  return symlinkPaths
}
