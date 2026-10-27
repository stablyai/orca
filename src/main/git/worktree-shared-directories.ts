import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'
import { loadHooks } from '../hooks'
import type { Repo } from '../../shared/repo-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

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

/** Share only existing gitignored directories; failures return [] so sharing cannot block creation. */
export async function resolveWorktreeSharedDirectories(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  try {
    const configured = loadHooks(repoPath)?.worktree?.sharedDirectories ?? []
    if (configured.length === 0) {
      return []
    }

    // Preserve configured order for deterministic warnings while probing concurrently.
    const probes = await mapWithConcurrency(
      configured,
      SHARED_DIRECTORY_STAT_CONCURRENCY,
      async (relativePath) => {
        try {
          return {
            relativePath,
            exists: true,
            isDirectory: (await stat(join(repoPath, relativePath))).isDirectory()
          }
        } catch {
          return { relativePath, exists: false, isDirectory: false }
        }
      }
    )
    const existing: string[] = []
    for (const probe of probes) {
      if (!probe.exists) {
        continue
      }
      if (probe.isDirectory) {
        existing.push(probe.relativePath)
      } else {
        console.warn(
          `[worktree-shared-directories] Skipping "${probe.relativePath}": sharedDirectories entries must be directories`
        )
      }
    }
    if (existing.length === 0) {
      return []
    }

    const ignored = new Set(await checkIgnoredPaths(repoPath, existing, options))
    for (const relativePath of existing) {
      if (!ignored.has(relativePath)) {
        console.warn(
          `[worktree-shared-directories] Skipping "${relativePath}": only gitignored directories can be shared`
        )
      }
    }
    return existing.filter((relativePath) => ignored.has(relativePath)).sort()
  } catch (error) {
    console.warn('[worktree-shared-directories] Failed to resolve shared directories:', error)
    return []
  }
}
