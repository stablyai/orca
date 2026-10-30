import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'
import { loadHooks } from '../hooks'
import type { Repo } from '../../shared/repo-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'
import type {
  WorktreeConfiguredPathResolveResult,
  WorktreeConfiguredPathSkip
} from './worktree-configured-path-skips'

const CONFIGURED_SHARED_DIRECTORIES_CACHE_TTL_MS = 30_000
export const MAX_CONFIGURED_SHARED_DIRECTORIES_CACHE_ENTRIES = 512
// Bound filesystem fan-out while overlapping independent probes.
const SHARED_DIRECTORY_STAT_CONCURRENCY = 8
const configuredSharedDirectoriesByRepoPath = new Map<
  string,
  { directories: string[]; expiresAt: number }
>()

/** Return the cached readonly names; removal needs them before existence/ignore filtering drops shared links. */
export function getConfiguredWorktreeSharedDirectories(repoPath: string): readonly string[] {
  const cached = configuredSharedDirectoriesByRepoPath.get(repoPath)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    configuredSharedDirectoriesByRepoPath.delete(repoPath)
    configuredSharedDirectoriesByRepoPath.set(repoPath, cached)
    return cached.directories
  }
  const configured = loadHooks(repoPath)?.worktree?.sharedDirectories ?? []
  configuredSharedDirectoriesByRepoPath.set(repoPath, {
    directories: configured,
    expiresAt: now + CONFIGURED_SHARED_DIRECTORIES_CACHE_TTL_MS
  })
  while (
    configuredSharedDirectoriesByRepoPath.size > MAX_CONFIGURED_SHARED_DIRECTORIES_CACHE_ENTRIES
  ) {
    const oldest = configuredSharedDirectoriesByRepoPath.keys().next()
    if (oldest.done || oldest.value === repoPath) {
      break
    }
    configuredSharedDirectoriesByRepoPath.delete(oldest.value)
  }
  return configured
}

export function clearConfiguredWorktreeSharedDirectoriesCacheForTests(): void {
  configuredSharedDirectoriesByRepoPath.clear()
}

export function getConfiguredWorktreeSharedDirectoriesCacheSizeForTests(): number {
  return configuredSharedDirectoriesByRepoPath.size
}

/** Configured link candidates; pair with findExistingWorktreeSymlinkPaths to preserve user-owned regular files. */
export function getWorktreeSharedLinkPaths(repo: Pick<Repo, 'path' | 'symlinkPaths'>): string[] {
  return Array.from(
    new Set([...(repo.symlinkPaths ?? []), ...getConfiguredWorktreeSharedDirectories(repo.path)])
  )
}

/** Resolve `worktree.sharedDirectories` from the repo-root `orca.yaml` to
 *  concrete repo-relative directories to symlink into a new worktree.
 *
 *  Only directories that exist in the primary checkout **and** are gitignored are
 *  shared: tracked directories are already materialized by the checkout, and
 *  sharing an unignored path would surface the link as a spurious worktree diff.
 *  Skipped entries are returned so create can warn instead of reporting a silent
 *  success.
 *
 *  Never throws — any read/parse/git failure resolves to empty paths so worktree
 *  creation is never blocked by this file. */
export async function resolveWorktreeSharedDirectories(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<WorktreeConfiguredPathResolveResult> {
  const skipped: WorktreeConfiguredPathSkip[] = []
  try {
    const configured = loadHooks(repoPath)?.worktree?.sharedDirectories ?? []
    if (configured.length === 0) {
      return { paths: [], skipped }
    }

    // Keep only entries that exist as directories; a listed but absent path
    // (node_modules before install) has nothing to share. Probe concurrently,
    // and record skips below in configured order.
    const probes = await mapWithConcurrency(
      configured,
      SHARED_DIRECTORY_STAT_CONCURRENCY,
      async (relativePath) => {
        try {
          return {
            relativePath,
            exists: true as const,
            isDirectory: (await stat(join(repoPath, relativePath))).isDirectory()
          }
        } catch (error) {
          // Why: ENOENT is "not installed yet"; EACCES/EIO are not the same skip.
          const reason: 'missing' | 'stat-failed' =
            (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'stat-failed'
          return {
            relativePath,
            exists: false as const,
            isDirectory: false,
            reason
          }
        }
      }
    )
    const existing: string[] = []
    for (const probe of probes) {
      if (!probe.exists) {
        skipped.push({
          mechanism: 'share',
          path: probe.relativePath,
          reason: probe.reason
        })
        continue
      }
      if (probe.isDirectory) {
        existing.push(probe.relativePath)
      } else {
        console.warn(
          `[worktree-shared-directories] Skipping "${probe.relativePath}": sharedDirectories entries must be directories`
        )
        skipped.push({
          mechanism: 'share',
          path: probe.relativePath,
          reason: 'not-directory'
        })
      }
    }
    if (existing.length === 0) {
      return { paths: [], skipped }
    }

    const ignored = new Set(await checkIgnoredPaths(repoPath, existing, options))
    const paths: string[] = []
    for (const relativePath of existing) {
      if (!ignored.has(relativePath)) {
        console.warn(
          `[worktree-shared-directories] Skipping "${relativePath}": only gitignored directories can be shared`
        )
        skipped.push({ mechanism: 'share', path: relativePath, reason: 'not-gitignored' })
        continue
      }
      paths.push(relativePath)
    }
    return { paths: paths.sort(), skipped }
  } catch (error) {
    console.warn('[worktree-shared-directories] Failed to resolve shared directories:', error)
    return { paths: [], skipped }
  }
}
