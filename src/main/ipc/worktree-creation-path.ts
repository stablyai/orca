import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isWslUncPath } from '../../shared/wsl-paths'

/**
 * Best-effort canonicalizer for a local worktree creation path that may not
 * exist on disk yet.  Walks upward from the not-yet-created target to find
 * the nearest existing ancestor, resolves it through the OS path layer, and
 * reattaches the missing tail so symlinks in the parent are normalized away.
 *
 * WSL UNC paths are returned unchanged because the host filesystem is not
 * directly accessible from the Node fs layer.
 */
export function canonicalizeLocalWorktreeCreationPath(targetPath: string): string {
  // Why: WSL UNC paths (\\wsl.localhost\... or //wsl$/...) resolve to a Linux
  // host that Node cannot reach via the Windows fs layer, so realpath would
  // always fail.  Skip the entire walk before any filesystem access.
  if (isWslUncPath(targetPath)) {
    return targetPath
  }

  const missingTail: string[] = []
  let candidate = targetPath

  // Walk upward until we find an existing ancestor or hit the root.
  while (!existsSync(candidate)) {
    missingTail.push(basename(candidate))
    const parent = dirname(candidate)
    if (parent === candidate) {
      // Reached root with no existing ancestor; return unchanged.
      return targetPath
    }
    candidate = parent
  }

  // Canonicalize the existing ancestor.  Prefer native realpath (follows
  // Windows symlinks correctly); fall back to the generic one if native fails.
  let canonical: string
  try {
    canonical = realpathSync.native(candidate)
  } catch {
    try {
      canonical = realpathSync(candidate)
    } catch {
      // Both realpath variants failed; return the original path unchanged.
      return targetPath
    }
  }

  // Rejoin the canonical ancestor with the missing tail in original order.
  missingTail.reverse()
  return join(canonical, ...missingTail)
}
