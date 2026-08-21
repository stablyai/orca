import { lstat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

// Why this is a leaf module rather than part of ipc/worktree-symlinks: status
// and review-creation need only the read-only "is this a symlink" question, and
// importing the materialization module would pull APFS cloning — and its
// child_process dependency — into their graph.

export type SafeRelativePathResult = { safe: true; rel: string } | { safe: false }

export function getSafeRelativePath(rawPath: string): SafeRelativePathResult {
  // Why: strip leading separators (both `/` and `\`) before the guard so
  // Windows-style input like `\foo` is normalized the same way POSIX `/foo`
  // is, and the traversal check below sees the already-relative form.
  const rel = rawPath.trim().replace(/^[\\/]+/, '')
  // Why: split on both separators so a Windows-authored `..\escape` is
  // rejected the same way POSIX `../escape` is. `path.isAbsolute` catches
  // drive-letter absolutes (`C:\...`); the split catches relative
  // backslash traversal that `.split('/')` would otherwise miss.
  if (!rel || isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    return { safe: false }
  }
  return { safe: true, rel }
}

export async function findExistingWorktreeSymlinkPaths(
  worktreePath: string,
  paths: readonly string[]
): Promise<string[]> {
  const symlinkPaths: string[] = []
  for (const rawPath of paths) {
    const safePath = getSafeRelativePath(rawPath)
    if (!safePath.safe) {
      continue
    }
    try {
      if ((await lstat(resolve(worktreePath, safePath.rel))).isSymbolicLink()) {
        symlinkPaths.push(safePath.rel)
      }
    } catch {
      // Why: only a positively identified symlink may bypass dirty preflight.
    }
  }
  return symlinkPaths
}
