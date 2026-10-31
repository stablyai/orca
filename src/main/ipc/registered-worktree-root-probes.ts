import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withTimeout } from '../../shared/promise-timeout-fallback'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { isPerforceCopyWorktreeIdForRepo } from '../../shared/worktree/perforce-copy-worktree'
import { getErrorCode } from '../git/worktree-operation-options'
import { resolveLocalProjectRuntimesForRepos } from '../local-project-runtime-resolution'
import type { RegisteredWorktreeRootStore as RootStore } from './registered-worktree-root-store'
import { getWorktreeMirrorDistroForRuntime } from '../project-runtime-git-options'
import { listRepoWorktreeGraph } from '../repo-worktrees'
import { blockedWslDistroForPath, wslDistroForPath } from '../wsl/wsl-unc-access-gate'

const CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS = 1_000
const AUTHORIZED_ROOTS_REBUILD_CONCURRENCY = 8

/**
 * `wslDistro` names the Git that listed the roots; undefined is host Git. `deferred`: the repo's
 * distro is stopped, so it was not listed; its owner stays dirty for a later rebuild.
 */
type ListedRoots = {
  roots: Set<string>
  listingFailed: boolean
  wslDistro: string | undefined
  deferred?: true
}

/** List through project-runtime Git so WSL/host path spellings match catalog/removal; repair-pending runtimes retain host listing. */
export async function listWorktreeRootsWithConcurrency(
  store: RootStore,
  repos: readonly Repo[]
): Promise<ListedRoots[]> {
  const runtimes = resolveLocalProjectRuntimesForRepos(store, repos)
  // Perforce copies of folder projects are known only from metadata; skip the read when none can exist.
  const worktreeMeta =
    repos.some(isFolderRepo) && typeof store.getAllWorktreeMeta === 'function'
      ? store.getAllWorktreeMeta()
      : {}
  const results: ListedRoots[] = []
  let nextIndex = 0
  await Promise.all(
    Array.from(
      { length: Math.min(AUTHORIZED_ROOTS_REBUILD_CONCURRENCY, repos.length) },
      async () => {
        while (nextIndex < repos.length) {
          const index = nextIndex++
          const repo = repos[index]
          const wslDistro = getWorktreeMirrorDistroForRuntime(runtimes.get(repo.id))
          const repoPath = repo.path
          const roots = new Set([resolve(repoPath)])
          // Any authorization miss rebuilds; listing a stopped distro's repo would boot it (E9).
          if (
            wslDistroForPath(repoPath, wslDistro) &&
            (await blockedWslDistroForPath(repoPath, wslDistro))
          ) {
            results[index] = { roots, listingFailed: true, wslDistro, deferred: true }
            continue
          }
          let listingFailed = false
          try {
            for (const worktree of await listRepoWorktreeGraph(
              repo,
              wslDistro ? { wslDistro } : {}
            )) {
              roots.add(resolve(worktree.path))
            }
            for (const copyPath of perforceCopyPaths(repo, worktreeMeta)) {
              roots.add(resolve(copyPath))
            }
          } catch (error) {
            console.warn(
              `[filesystem-auth] skipping repo ${repo.path} during cache rebuild:`,
              error
            )
            listingFailed = true
          }
          results[index] = { roots, listingFailed, wslDistro }
        }
      }
    )
  )
  return results
}

function perforceCopyPaths(repo: Repo, worktreeMeta: Record<string, WorktreeMeta>): string[] {
  if (!isFolderRepo(repo)) {
    return []
  }
  return Object.entries(worktreeMeta).flatMap(([worktreeId, meta]) => {
    // Why: main stamps a copy it records with creation provenance, which renderer meta writes cannot
    // set, so a copy-shaped id written through `worktrees:updateMeta` never authorizes its folder.
    const path =
      meta.orcaCreatedAt !== undefined && isPerforceCopyWorktreeIdForRepo(repo, worktreeId)
        ? splitWorktreeId(worktreeId)?.worktreePath
        : undefined
    return path ? [path] : []
  })
}

/** An unavailable mount is not evidence that a recovered worktree disappeared. */
export async function pruneCreatedWorktreeRoots(
  recoveredRoots: ReadonlySet<string>,
  listed: ListedRoots
): Promise<Set<string>> {
  const recovered = new Set(recoveredRoots)
  if (!listed.listingFailed) {
    await Promise.all(
      [...recovered].map(async (root) => {
        if (listed.roots.has(root) || (await isRootGoneFromDisk(root))) {
          recovered.delete(root)
        }
      })
    )
  }
  return recovered
}

async function isRootGoneFromDisk(targetPath: string): Promise<boolean> {
  const probe = stat(targetPath).then(
    () => false,
    (error: unknown) => getErrorCode(error) === 'ENOENT'
  )
  return withTimeout(probe, CREATED_WORKTREE_ROOT_PROBE_TIMEOUT_MS, false)
}
