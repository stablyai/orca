import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withTimeout } from '../../../../shared/concurrency/promise-timeout-fallback'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { isPerforceCopyWorktreeIdForRepo } from '../../../../shared/worktree/perforce-copy-worktree'
import { getErrorCode } from '../../../git/worktrees/worktree-operation-options'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import type { RegisteredWorktreeRootStore as RootStore } from './registered-worktree-root-store'
import { getWorktreeMirrorDistroForRuntime } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listRepoWorktreeGraph } from '../../../workspaces/catalog/repo-worktrees'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'

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
  const copyMetaByHost = new Map<ExecutionHostId, Record<string, WorktreeMeta>>()
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
            for (const copyPath of perforceCopyPaths(store, repo, copyMetaByHost)) {
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

// Perforce copies of folder projects are known only from metadata.
function perforceCopyPaths(
  store: RootStore,
  repo: Repo,
  metaByHost: Map<ExecutionHostId, Record<string, WorktreeMeta>>
): string[] {
  if (!isFolderRepo(repo)) {
    return []
  }
  const hostId = getRepoExecutionHostId(repo)
  // Why per host: a same-id repo on another host may record copy paths that exist only there.
  const worktreeMeta =
    metaByHost.get(hostId) ??
    store.getAllWorktreeMetaForHost?.(hostId) ??
    readAllWorktreeMetaForHost(
      { getAllWorktreeMeta: () => store.getAllWorktreeMeta?.() ?? {} },
      hostId
    )
  metaByHost.set(hostId, worktreeMeta)
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
