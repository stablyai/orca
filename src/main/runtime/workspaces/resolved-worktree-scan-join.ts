import type { Repo } from '../../../shared/repo-types'
import { isFolderRepo } from '../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  getRepoHostIdentityForParts,
  type HostScopedRepoKey
} from '../../../shared/repo-host-identity'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../shared/worktree/host-qualified-identity'
import { projectResolvedWorktreeLineage } from '../../../shared/resolved-worktree-lineage'
import { resolveLocalProjectRuntimesForRepos } from '../../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from '../runtime-agent-launch-resolution'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../runtime-store-contract'
import {
  joinRepoWorktreeRows,
  scanRepoWorktreeRows,
  type RepoWorktreeRowDeps,
  type RepoWorktreeRowsScan
} from '../repo-worktree-row-resolution'

/**
 * Per-repo scans by repo and execution host, since one repo id can live on two hosts. `gitRun` is
 * the scan-cache entry the result came from: a new one only when the host was consulted again.
 */
export type ResolvedWorktreeRepoScans = Map<
  HostScopedRepoKey,
  RepoWorktreeRowsScan & { gitRun: object | null }
>

export type ResolvedWorktreeScanJoin = ResolvedWorktreeSnapshot & {
  /** Git repos the scans predate, which list no rows until scanned. */
  unscannedRepoKeys: ReadonlySet<HostScopedRepoKey>
  /** Rows a scan that reached a verdict listed, by their git run; a stalled scan's carry no branch. */
  gitRunById: ReadonlyMap<HostScopedWorktreeKey, object | null>
  /** Repos whose scan reached a verdict, so a row they no longer list is gone. */
  scannedRepoKeys: ReadonlySet<HostScopedRepoKey>
}

function resolvedWorktreeRepoScanKey(repo: Repo): HostScopedRepoKey {
  return getRepoHostIdentityForParts(repo.id, getRepoExecutionHostId(repo))
}

export function platformsByRepoId(
  repos: readonly Repo[],
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
): Map<string, NodeJS.Platform> {
  return new Map(
    repos.map((repo) => [
      repo.id,
      getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
    ])
  )
}

/** Every git repo's scan, with no metadata; `scanCacheEntry` names the cache entry it came from. */
export async function scanResolvedWorktreeRepos(
  store: RuntimeStore | null,
  rowDeps: () => RepoWorktreeRowDeps,
  scanCacheEntry: (scanScopeKey: string) => object | undefined
): Promise<ResolvedWorktreeRepoScans> {
  const scans: ResolvedWorktreeRepoScans = new Map()
  if (!store) {
    return scans
  }
  const repos = store.getRepos().filter((repo) => !isFolderRepo(repo))
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, repos)
  const deps = rowDeps()
  await Promise.all(
    repos.map(async (repo) => {
      const scan = await scanRepoWorktreeRows(deps, repo, projectRuntimeByRepoId)
      // The key listRepoWorktreesForResolution caches under.
      const gitRun = scanCacheEntry(`${repo.id}\0${getRepoExecutionHostId(repo)}`) ?? null
      scans.set(resolvedWorktreeRepoScanKey(repo), { ...scan, gitRun })
    })
  )
  return scans
}

/**
 * The fleet listing from cached scans and the store as it is now, synchronously. A git repo the
 * scans predate lists no rows yet and is counted, so its owner can scan again.
 */
export function joinResolvedWorktreeScans(
  store: RuntimeStore | null,
  rowDeps: () => RepoWorktreeRowDeps,
  scans: ResolvedWorktreeRepoScans
): ResolvedWorktreeScanJoin {
  if (!store) {
    return {
      worktrees: [],
      platformByRepoId: new Map(),
      unscannedRepoKeys: new Set(),
      gitRunById: new Map(),
      scannedRepoKeys: new Set()
    }
  }
  const metaById = store.getAllWorktreeMeta() ?? {}
  const repos = store.getRepos()
  const platformByRepoId = platformsByRepoId(
    repos,
    resolveLocalProjectRuntimesForRepos(store, repos)
  )
  const deps = rowDeps()
  const unscannedRepoKeys = new Set<HostScopedRepoKey>()
  const gitRunById = new Map<HostScopedWorktreeKey, object | null>()
  const scannedRepoKeys = new Set<HostScopedRepoKey>()
  const perRepoWorktrees = repos.map((repo) => {
    const key = resolvedWorktreeRepoScanKey(repo)
    const scan = scans.get(key) ?? null
    if (!scan && !isFolderRepo(repo)) {
      unscannedRepoKeys.add(key)
    }
    const rows = joinRepoWorktreeRows(deps, repo, scan, metaById)
    if (scan?.ok) {
      scannedRepoKeys.add(key)
      for (const row of rows) {
        gitRunById.set(composeWorktreeHostIdentity(row.hostId, row.id), scan.gitRun)
      }
    }
    return rows
  })
  const worktrees = projectResolvedWorktreeLineage(
    perRepoWorktrees.flat(),
    store.getAllWorktreeLineage?.() ?? {}
  )
  return { worktrees, platformByRepoId, unscannedRepoKeys, gitRunById, scannedRepoKeys }
}
