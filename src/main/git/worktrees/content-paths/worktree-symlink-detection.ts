import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { resolveWorktreeHostPath } from '../../../../shared/git/metadata/git-metadata-path'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'

// Keep read-only symlink detection independent of APFS materialization and child-process imports.

export type SafeRelativePathResult = { safe: true; rel: string } | { safe: false }

// isAbsolute misses drive-relative C:foo, which still escapes the worktree on Windows.
const WINDOWS_DRIVE_DESIGNATOR = /^[a-zA-Z]:/
const SYMLINK_PROBE_CONCURRENCY = 8

export function getSafeRelativePath(rawPath: string): SafeRelativePathResult {
  // Strip either separator style before validating so host syntax cannot change the verdict.
  const rel = rawPath.trim().replace(/^[\\/]+/, '')
  // Validate both separator styles and drive prefixes after ./ normalization on every host.
  const segments = rel.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.')
  if (
    segments.length === 0 ||
    WINDOWS_DRIVE_DESIGNATOR.test(segments[0]) ||
    segments.includes('..')
  ) {
    return { safe: false }
  }
  // Match Git's normalized spelling, using only separators the host filesystem resolves.
  const gitRel =
    sep === '\\'
      ? segments.join('/')
      : rel
          .split('/')
          .filter((segment) => segment !== '' && segment !== '.')
          .join('/')
  return gitRel ? { safe: true, rel: gitRel } : { safe: false }
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
  // Node filesystem reads need host spelling even when WSL Git reported guest paths.
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options) ?? worktreePath
  const safePaths = paths.flatMap((rawPath) => {
    const safePath = getSafeRelativePath(rawPath)
    return safePath.safe ? [safePath.rel] : []
  })
  // Independent lstats: overlap them so slow WSL/UNC round-trips don't serialize git status.
  const isSymlink = await mapWithConcurrency(safePaths, SYMLINK_PROBE_CONCURRENCY, (rel) =>
    lstat(resolve(hostWorktreePath, rel)).then(
      (stats) => stats.isSymbolicLink(),
      // Why: only a positively identified symlink may bypass dirty preflight.
      () => false
    )
  )
  return safePaths.filter((_, index) => isSymlink[index])
}
