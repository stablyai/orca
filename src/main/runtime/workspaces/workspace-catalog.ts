import { OrcaRuntimeWithReadKittyFile } from '../orca-runtime-read-kitty-file'
import type { RuntimeWorkspaceRepoScanRefresh } from './workspace-repo-scan-refresh'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import type { ResolvedWorktreeSnapshot } from '../runtime-resolved-worktree-cache'
import { RESOLVED_WORKTREE_CACHE_TTL_MS } from '../orca-runtime-postlude'
import { getWorktreeScanMutationRevision } from '../../local-worktree-scan-generation'
import {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../../project-runtime-git-options'
import {
  resolveRepoWorktreeRows,
  resolveScopedWorktreeIdRow,
  type RepoWorktreeRowDeps
} from '../repo-worktree-row-resolution'
import {
  joinResolvedWorktreeScans,
  platformsByRepoId,
  scanResolvedWorktreeRepos,
  type ResolvedWorktreeRepoScans,
  type ResolvedWorktreeScanJoin
} from './resolved-worktree-scan-join'
import { projectResolvedWorktreeLineage } from '../../../shared/resolved-worktree-lineage'
import { listRuntimeFolderWorkspaces } from '../runtime-worktree-filesystem'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host'
import { withUnregisteredRemovalCheckouts } from '../../worktree-removal-listing'
import { withoutInFlightWorktreeCreates } from '../../worktree-create-in-flight'
import { preserveFolderUpgradeWorktreePath } from '../../folder-upgrade-worktree-path'
import type { RuntimeWorktreeScanCache } from '../orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'

export abstract class RuntimeWorkspaceCatalog extends OrcaRuntimeWithReadKittyFile {
  protected abstract refreshRepoWorktreeScan(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>
  ): ReturnType<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>

  protected listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    if (!this.store || !targetWorktree) {
      return []
    }
    const target = splitWorktreeIdForFilesystem(targetWorktreeId)
    if (!target?.repoId || !target.worktreePath) {
      // Folder workspace keys have no repo/path tuple, but the converted row
      // is already authoritative for this explicit target.
      return [targetWorktree]
    }
    const worktreeIds = new Set(
      Object.keys(this.store.getAllWorktreeMeta()).filter((worktreeId) => {
        const parsed = splitWorktreeIdForFilesystem(worktreeId)
        return (
          parsed?.repoId === target.repoId &&
          Boolean(parsed.worktreePath) &&
          (isPathInsideOrEqual(target.worktreePath, parsed.worktreePath) ||
            isPathInsideOrEqual(parsed.worktreePath, target.worktreePath))
        )
      })
    )
    worktreeIds.add(targetWorktreeId)

    const resolved: ResolvedWorktree[] = []
    for (const worktreeId of worktreeIds) {
      const worktree =
        worktreeId === targetWorktreeId
          ? targetWorktree
          : this.buildResolvedWorktreeFromId(worktreeId)
      if (worktree) {
        resolved.push(worktree)
      }
    }
    return resolved
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

  protected joinResolvedWorktreeScans(scans: ResolvedWorktreeRepoScans): ResolvedWorktreeScanJoin {
    return joinResolvedWorktreeScans(this.store, this.repoWorktreeRowDeps.bind(this), scans)
  }

  protected repoWorktreeRowDeps(): RepoWorktreeRowDeps {
    const store = this.requireStore()
    return {
      store,
      scanRepo: (repo, projectRuntimeByRepoId) =>
        this.listRepoWorktreesForListing(repo, projectRuntimeByRepoId),
      listFolderWorkspaces: (repo, repoOwnerCount) =>
        listRuntimeFolderWorkspaces(store, repo, repoOwnerCount)
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
    return scan.ok && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? {
          ok: true,
          worktrees: await withUnregisteredRemovalCheckouts(
            repo.id,
            withoutInFlightWorktreeCreates(repo.id, scan.worktrees)
          )
        }
      : scan
  }

  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    // Resolve executionHostId-only SSH rows too; local routing would miskey caches and miss provider replacements.
    const sshConnectionId = getRepoSshConnectionId(repo)
    const projectRuntime = projectRuntimeByRepoId
      ? projectRuntimeByRepoId.get(repo.id)
      : !sshConnectionId
        ? resolveLocalProjectRuntimeForRepo(this.requireStore(), repo)
        : undefined
    const runtimeKey = projectRuntime
      ? projectRuntime.status === 'resolved'
        ? projectRuntime.runtime.cacheKey
        : projectRuntime.repair.cacheKey
      : sshConnectionId
        ? `ssh:${sshConnectionId}`
        : 'local:default'
    const now = Date.now()
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scanScopeKey) ?? 0
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      const refresh = await inFlight.promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      return refresh.result
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
    this.worktreeScanInFlight.set(scanScopeKey, { generation, runtimeKey, promise })
    try {
      const refresh = await promise
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      if (
        (refresh.result.ok || !sshConnectionId) &&
        this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise
      ) {
        const entry: RuntimeWorktreeScanCache = {
          generation,
          runtimeKey,
          result: refresh.result,
          expiresAt: Date.now() + resolveWorktreeScanCacheTtlMs(repo),
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
      return refresh.result
    } finally {
      if (this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise) {
        this.worktreeScanInFlight.delete(scanScopeKey)
      }
    }
  }
}
