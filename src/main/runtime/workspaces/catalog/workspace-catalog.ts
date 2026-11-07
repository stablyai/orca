import { OrcaRuntimeWithReadKittyFile } from '../../files/paths/orca-runtime-read-kitty-file'
import type { RuntimeWorkspaceRepoScanRefresh } from './workspace-repo-scan-refresh'
import {
  listKnownResolvedWorktreesForExplicitTarget,
  type ResolvedWorktree
} from './runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'

import { getWorktreeScanMutationRevision } from '../../../workspaces/catalog/local-worktree-scan-generation'
import {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../../../workspaces/execution-host/local-project-runtime-resolution'
import {
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  type RepoWorktreeRowDeps
} from './repo-worktree-row-resolution'
import {
  joinResolvedWorktreeScans,
  platformsByRepoId,
  scanResolvedWorktreeRepos,
  type ResolvedWorktreeRepoScans,
  type ResolvedWorktreeScanJoin
} from './resolved-worktree-scan-join'
import { projectResolvedWorktreeLineage } from '../../../../shared/resolved-worktree-lineage'
import * as RuntimeFolders from './runtime-worktree-filesystem'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { withUnregisteredRemovalCheckouts } from '../../../workspaces/removal/worktree-removal-listing'
import { withoutInFlightWorktreeCreates } from '../../../workspaces/creation/worktree-create-in-flight'
import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
import type { RuntimeWorktreeScanCache } from './runtime-worktree-scan-state'
import * as ScanCache from './runtime-worktree-scan-cache'
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000

export abstract class RuntimeWorkspaceCatalog extends OrcaRuntimeWithReadKittyFile {
  protected abstract refreshRepoWorktreeScan(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>
  ): ReturnType<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>

  protected listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    const store = this.store
    if (!store || !targetWorktree) {
      return []
    }
    return listKnownResolvedWorktreesForExplicitTarget(
      targetWorktreeId,
      targetWorktree,
      () => Object.keys(store.getAllWorktreeMeta()),
      (worktreeId) => this.buildResolvedWorktreeFromId(worktreeId)
    )
  }

  /** A warm fleet snapshot already answers any selector for free, so scoped scanning must yield to it. */
  protected hasFreshResolvedWorktreeCache(): boolean {
    return this.resolvedWorktrees.isFresh(getWorktreeScanMutationRevision())
  }

  protected async listResolvedWorktrees(): Promise<ResolvedWorktree[]> {
    return (await this.listResolvedWorktreeSnapshot()).worktrees
  }

  protected async listResolvedWorktreeSnapshot(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    return this.resolvedWorktrees.getSnapshot(
      () => this.computeResolvedWorktrees(),
      RESOLVED_WORKTREE_CACHE_TTL_MS,
      getWorktreeScanMutationRevision()
    )
  }

  protected async computeResolvedWorktrees(): Promise<ResolvedWorktreeSnapshot> {
    if (!this.store) {
      return { worktrees: [], platformByRepoId: new Map() }
    }
    const metaById = this.store.getAllWorktreeMeta() ?? {}
    const repos = this.store.getRepos()
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = platformsByRepoId(repos, projectRuntimeByRepoId)
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) => await resolveRepoWorktreeRows(deps, repo, metaById, projectRuntimeByRepoId)
      )
    )
    const lineageById = this.store?.getAllWorktreeLineage?.() ?? {}
    const worktrees = projectResolvedWorktreeLineage(perRepoWorktrees.flat(), lineageById)
    return { worktrees, platformByRepoId }
  }

  protected scanResolvedWorktreeRepos(): Promise<ResolvedWorktreeRepoScans> {
    return scanResolvedWorktreeRepos(this.store, this.repoWorktreeRowDeps.bind(this), (key) =>
      this.worktreeScanCache.get(key)
    )
  }

  protected pruneUnregisteredWorktreeScans(): void {
    ScanCache.pruneUnregisteredWorktreeScans(this.store?.getRepos() ?? [], [
      this.worktreeScanCache,
      this.worktreeScanGenerations,
      this.worktreeScanInFlight
    ])
  }

  protected joinResolvedWorktreeScans(scans: ResolvedWorktreeRepoScans): ResolvedWorktreeScanJoin {
    return joinResolvedWorktreeScans(
      this.store,
      () => ({
        ...this.repoWorktreeRowDeps(),
        listFolderWorkspaces: (repo, count) =>
          RuntimeFolders.projectRuntimeFolderWorkspaces(this.requireStore(), repo, count)
      }),
      scans
    )
  }

  /** The fleet from cached scans for synchronous selector matching, reprojected only when its inputs change. */
  protected projectCachedWorktrees(): ResolvedWorktreeRowsJoin {
    const cachedScans = (this.store?.getRepos() ?? []).map((repo) => {
      const entry = this.worktreeScanCache.get(`${repo.id}\0${getRepoExecutionHostId(repo)}`)
      return { repo, entry, scan: entry && (entry.listing ?? entry.result) }
    })
    return this.resolvedWorktrees.projectCachedScans(
      this.store,
      cachedScans.flatMap(({ repo, entry, scan }) => [getRepoHostIdentity(repo), entry, scan]),
      () => {
        const scans: ResolvedWorktreeRepoScans = new Map()
        for (const { repo, entry, scan } of cachedScans) {
          if (entry && scan) {
            scans.set(getRepoHostIdentity(repo), {
              ...scan,
              gitRun: entry
            })
          }
        }
        return projectResolvedWorktreeScans(
          this.store,
          () => ({
            ...this.repoWorktreeRowDeps(),
            listFolderWorkspaces: (repo, count) =>
              RuntimeFolders.projectRuntimeFolderWorkspaces(this.requireStore(), repo, count)
          }),
          scans
        )
      }
    )
  }

  protected repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForListing(repo, projectRuntimeByRepoId),
      getCachedSuccessfulScan: (repo) => {
        const key = `${repo.id}\0${getRepoExecutionHostId(repo)}`
        const cached = this.worktreeScanCache.get(key)
        if (
          cached?.generation === (this.worktreeScanGenerations.get(key) ?? 0) &&
          cached.runtimeKey === ScanCache.resolveWorktreeScanRuntime(store, repo).runtimeKey &&
          cached.listing?.ok
        ) {
          return cached.listing
        }
        return undefined
      },
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        RuntimeFolders.listRuntimeFolderWorkspaces(store, repo, repoOwnerCount)
    }
  }

  protected async resolveExplicitWorktreeIdScoped(
    worktreeId: string,
    requiredHostId?: ExecutionHostId
  ): Promise<ResolvedWorktree | null> {
    if (!this.store) {
      return null
    }
    return await resolveScopedWorktreeIdRow(this.repoWorktreeRowDeps(), worktreeId, requiredHostId)
  }

  /** The resolution scan plus the checkouts this host's removals own that Git no longer lists. */
  protected async listRepoWorktreesForListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const cached = await this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
    // Paired detectedList must retain folder-upgrade locators or folder ids lose metadata and terminals (#30150).
    const scan = { ...cached, worktrees: preserveFolderUpgradeWorktreePath(repo, cached.worktrees) }
    const listing =
      scan.ok && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
        ? {
            ok: true,
            worktrees: await withUnregisteredRemovalCheckouts(
              repo.id,
              withoutInFlightWorktreeCreates(repo.id, scan.worktrees)
            )
          }
        : scan
    const cachedEntry = this.worktreeScanCache.get(`${repo.id}\0${getRepoExecutionHostId(repo)}`)
    if (cachedEntry?.result === cached) {
      cachedEntry.listing = listing
    }
    return listing
  }

  private worktreeScanScope(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ) {
    return ScanCache.worktreeScanScope(
      repo,
      this.worktreeScanGenerations,
      () => resolveLocalProjectRuntimeForRepo(this.requireStore(), repo),
      projectRuntimeByRepoId
    )
  }

  /** The listing this catalog would answer for `repo` right now without scanning; null once replaced, expired or invalidated. */
  protected currentRepoWorktreeListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): RuntimeWorktreeScanResult | null {
    const { scanScopeKey, fresh } = this.worktreeScanScope(repo, projectRuntimeByRepoId)
    const cached = this.worktreeScanCache.get(scanScopeKey)
    return cached && fresh(cached, Date.now()) ? cached.result : null
  }

  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const { sshConnectionId, projectRuntime, runtimeKey, scanScopeKey, generation, fresh } =
      this.worktreeScanScope(repo, projectRuntimeByRepoId)
    const now = Date.now()
    const retryCurrent = (): Promise<RuntimeWorktreeScanResult> => {
      const current = this.store
        ?.getRepos()
        .find(
          (candidate) =>
            candidate.id === repo.id &&
            getRepoExecutionHostId(candidate) === getRepoExecutionHostId(repo)
        )
      return current
        ? this.listRepoWorktreesForResolution(current)
        : Promise.resolve({ ok: false, worktrees: [] })
    }
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (cached && fresh(cached, now)) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      return (await inFlight.promise).result
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
      .then(async (refresh) => {
        if (this.worktreeScanInFlight.get(scanScopeKey)?.promise !== promise) {
          return { ...refresh, result: await retryCurrent() }
        }
        if (refresh.result.ok || !sshConnectionId) {
          const entry: RuntimeWorktreeScanCache = {
            generation,
            runtimeKey,
            result: refresh.result,
            expiresAt: Date.now() + ScanCache.resolveWorktreeScanCacheTtlMs(repo),
            adminFingerprint: refresh.adminFingerprint,
            scannedAt: refresh.scannedAt
          }
          this.worktreeScanCache.set(scanScopeKey, entry)
          void refresh.adminFingerprintProbe?.then((fingerprint) => {
            if (this.worktreeScanCache.get(scanScopeKey) === entry) {
              entry.adminFingerprint = fingerprint
            }
          })
        }
        return refresh
      })
      .finally(() => {
        if (this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise) {
          this.worktreeScanInFlight.delete(scanScopeKey)
        }
      })
    this.worktreeScanInFlight.set(scanScopeKey, { generation, runtimeKey, promise })
    return (await promise).result
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }
}
