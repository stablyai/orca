import type { Repo } from '../../../../shared/repo-types'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import {
  getRepoHostIdentityForParts,
  type HostScopedRepoKey
} from '../../../../shared/repo-host-identity'
import {
  composeWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { getAgentLaunchPlatformForRepo } from '../../terminal/launch/runtime-agent-launch-resolution'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  joinRepoWorktreeRows,
  scanRepoWorktreeRows,
  type RepoWorktreeRowDeps,
  type RepoWorktreeRowsScan
} from './repo-worktree-row-resolution'

/** Key scans by repo and host; gitRun identifies the cache entry and changes only when the host is consulted. */
export type ResolvedWorktreeRepoScans = Map<
  HostScopedRepoKey,
  RepoWorktreeRowsScan & { gitRun: object | null }
>

export type ResolvedWorktreeRowsJoin = Pick<ResolvedWorktreeSnapshot, 'worktrees'> & {
  /** Git repos the scans predate, which list no rows until scanned. */
  unscannedRepoKeys: ReadonlySet<HostScopedRepoKey>
  /** Rows a scan that reached a verdict listed, by their git run; stalled scans remain degraded. */
  gitRunById: ReadonlyMap<HostScopedWorktreeKey, object | null>
  /** Repos whose scan reached a verdict, so a row they no longer list is gone. */
  scannedRepoKeys: ReadonlySet<HostScopedRepoKey>
}

export type ResolvedWorktreeScanJoin = ResolvedWorktreeSnapshot & ResolvedWorktreeRowsJoin

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
  scanCacheEntry: (repo: Repo) => object | undefined
): Promise<ResolvedWorktreeRepoScans> {
  const scans: ResolvedWorktreeRepoScans = new Map()
  if (!store) {
    return scans
  }
  const registered = store.getRepos()
  const repoOwners = createRepoRowExecutionHostLookup(registered)
  const repos = registered.filter((repo) => !isFolderRepo(repo))
  const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(store, repos)
  const deps = rowDeps()
  await Promise.all(
    repos.map(async (repo) => {
      const scan = await scanRepoWorktreeRows(
        deps,
        repo,
        projectRuntimeByRepoId,
        repoOwners.rowsFor(repo.id).length
      )
      // The owner observation the scan answered from; verification never mints a new one.
      const gitRun = scanCacheEntry(repo) ?? null
      scans.set(resolvedWorktreeRepoScanKey(repo), { ...scan, gitRun })
    })
  )
  return scans
}

/** Join cached scans with current metadata; count newly registered repos with no rows so owners can rescan. */
export function joinResolvedWorktreeScans(
  store: RuntimeStore | null,
  rowDeps: () => RepoWorktreeRowDeps,
  scans: ResolvedWorktreeRepoScans
): ResolvedWorktreeScanJoin {
  const repos = store?.getRepos() ?? []
  const platformByRepoId = store
    ? platformsByRepoId(repos, resolveLocalProjectRuntimesForRepos(store, repos))
    : new Map<string, NodeJS.Platform>()
  return { ...joinRows(store, rowDeps, scans, repos), platformByRepoId }
}

function joinRows(
  store: RuntimeStore | null,
  rowDeps: () => RepoWorktreeRowDeps,
  scans: ResolvedWorktreeRepoScans,
  repos: readonly Repo[]
): ResolvedWorktreeRowsJoin {
  if (!store) {
    return {
      worktrees: [],
      unscannedRepoKeys: new Set(),
      gitRunById: new Map(),
      scannedRepoKeys: new Set()
    }
  }
  const metaById = store.getAllWorktreeMeta() ?? {}
  const repoOwners = createRepoRowExecutionHostLookup(repos)
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
    const rows = joinRepoWorktreeRows(
      deps,
      repo,
      scan,
      metaById,
      repoOwners.rowsFor(repo.id).length
    )
    if (scan?.ok && !scan.superseded && (!scan.isCurrent || scan.isCurrent())) {
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
  return { worktrees, unscannedRepoKeys, gitRunById, scannedRepoKeys }
}
