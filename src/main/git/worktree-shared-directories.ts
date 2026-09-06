import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { checkIgnoredPaths } from './check-ignored-paths'
import type { GitRuntimeOptions } from './git-runtime-options'
import { loadHooks } from '../hooks'
import type { Repo } from '../../shared/repo-types'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

// Why: a fresh worktree has no node_modules/.cache, and copying them is slow and
// duplicates disk; `orca.yaml` names the ones every worktree should share instead.

const CONFIGURED_SHARED_DIRECTORIES_CACHE_TTL_MS = 30_000
// Why: resolving a worktree may list many generated directories; overlap
// independent local probes without flooding the filesystem threadpool.
const SHARED_DIRECTORY_STAT_CONCURRENCY = 8
const configuredSharedDirectoriesByRepoPath = new Map<
  string,
  { directories: string[]; expiresAt: number }
>()

/** The configured `worktree.sharedDirectories` names, before any existence or
 *  gitignore filtering.
 *
 *  Why deletion can't reuse the resolver below: a directory-only ignore rule
 *  (`node_modules/`) matches the primary's real directory but never the
 *  worktree's symlink, so Git reports that symlink as untracked. Removal has to
 *  tolerate and unlink it, and the resolver would have already dropped it.
 *
 *  `readonly` because this is the cached array itself: a mutating caller would
 *  corrupt every later read for the rest of the TTL. Copying on return would fix
 *  that too, but this runs on the status-polling path — the type costs nothing. */
export function getConfiguredWorktreeSharedDirectories(repoPath: string): readonly string[] {
  const cached = configuredSharedDirectoriesByRepoPath.get(repoPath)
  const now = Date.now()
  if (cached && cached.expiresAt > now) {
    return cached.directories
  }
  const configured = loadHooks(repoPath)?.worktree?.sharedDirectories ?? []
  configuredSharedDirectoriesByRepoPath.set(repoPath, {
    directories: configured,
    expiresAt: now + CONFIGURED_SHARED_DIRECTORIES_CACHE_TTL_MS
  })
  return configured
}

/** Reset the process cache between tests. */
export function clearConfiguredWorktreeSharedDirectoriesCacheForTests(): void {
  configuredSharedDirectoriesByRepoPath.clear()
}

/** Every path Orca may have symlinked into a worktree: the per-user Worktree
 *  Shared Paths setting plus the repo's `orca.yaml` shared directories.
 *
 *  Callers pair this with `findExistingWorktreeSymlinkPaths`, which keeps only
 *  the entries that really are symlinks — so a configured name that the user
 *  happens to own as a regular file is never treated as one of ours. */
export function getWorktreeSharedLinkPaths(repo: Pick<Repo, 'path' | 'symlinkPaths'>): string[] {
  return Array.from(
    new Set([...(repo.symlinkPaths ?? []), ...getConfiguredWorktreeSharedDirectories(repo.path)])
  )
}

/** Resolve `worktree.sharedDirectories` from the repo-root `orca.yaml` to
 *  concrete repo-relative directories to symlink into a new worktree.
 *
 *  Only directories that exist in the primary checkout **and** are gitignored are
 *  returned: tracked directories are already materialized by the checkout, and
 *  sharing an unignored path would surface the link as a spurious worktree diff.
 *
 *  Never throws — any read/parse/git failure resolves to `[]` so worktree
 *  creation is never blocked by this file. */
export async function resolveWorktreeSharedDirectories(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  try {
    const configured = loadHooks(repoPath)?.worktree?.sharedDirectories ?? []
    if (configured.length === 0) {
      return []
    }

    // Keep only entries that exist as directories; a listed but absent path
    // (node_modules before install) has nothing to share. The mapper retains
    // configured order; warnings are emitted below in that same order.
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
