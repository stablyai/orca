import { lstat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'

// Why this is a leaf module rather than part of ipc/worktree-symlinks: status
// and review-creation need only the read-only "is this a symlink" question, and
// importing the materialization module would pull APFS cloning — and its
// child_process dependency — into their graph.

export type SafeRelativePathResult = { safe: true; rel: string } | { safe: false }

// Why a regex rather than `path.isAbsolute`: the strip below already removed
// every leading `/` and `\`, so the only rooted spelling that can still reach
// the guard is a Windows drive designator — and `win32.isAbsolute` misses the
// drive-RELATIVE form (`C:foo`), which `win32.resolve` still resolves against
// that drive's current directory instead of the worktree root.
const WINDOWS_DRIVE_DESIGNATOR = /^[a-zA-Z]:/

export function getSafeRelativePath(rawPath: string): SafeRelativePathResult {
  // Why: strip leading separators (both `/` and `\`) before the guard so
  // Windows-style input like `\foo` is normalized the same way POSIX `/foo`
  // is, and the traversal check below sees the already-relative form.
  const rel = rawPath.trim().replace(/^[\\/]+/, '')
  // Why: split on both separators so a Windows-authored `..\escape` is
  // rejected the same way POSIX `../escape` is; the split catches relative
  // backslash traversal that `.split('/')` would otherwise miss.
  // Why the drive check runs on every host: the same entry — per-user Shared
  // Paths setting or repo `orca.yaml` — is evaluated on every host Orca runs
  // on, so the verdict must not depend on which one is asking.
  if (!rel || WINDOWS_DRIVE_DESIGNATOR.test(rel) || rel.split(/[\\/]/).includes('..')) {
    return { safe: false }
  }
  return { safe: true, rel }
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
