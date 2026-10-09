// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveWorktreeSelector } from './orca-runtime-resolve-worktree-selector'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import { RESOLVED_WORKTREE_CACHE_TTL_MS } from './orca-runtime-postlude'
import { getWorktreeScanMutationRevision } from '../local-worktree-scan-generation'
import {
  resolveLocalProjectRuntimeForRepo,
  resolveLocalProjectRuntimesForRepos
} from '../project-runtime-git-options'
import { getAgentLaunchPlatformForRepo } from './runtime-agent-launch-resolution'
import { resolveRepoWorktreeRows, resolveScopedWorktreeIdRow } from './repo-worktree-row-resolution'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import type { RepoWorktreeRowDeps } from './repo-worktree-row-resolution'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  LOCAL_EXECUTION_HOST_ID
} from '../../shared/execution-host'
import { withUnregisteredRemovalCheckouts } from '../worktree-removal-listing'
import type { RuntimeWorktreeScanCache } from './orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from './runtime-worktree-scan-cache'
import {
  createCapturedRepoCurrentGuard,
  type CapturedRepoCurrentGuard
} from '../ipc/worktrees/listing/worktree-host-ownership'
import type { RuntimeStore } from './runtime-store-contract'

export class OrcaRuntimeWithListKnownResolvedWorktreesForExplicitTarget extends OrcaRuntimeWithResolveWorktreeSelector {
  private readonly repoRegistrationGuards = new WeakMap<RuntimeStore, CapturedRepoCurrentGuard>()

  protected repoRegistrationGuard(initialRepos?: readonly Repo[]): CapturedRepoCurrentGuard {
    const store = this.requireStore()
    let guard = this.repoRegistrationGuards.get(store)
    if (!guard || initialRepos) {
      guard = createCapturedRepoCurrentGuard(store, initialRepos)
      this.repoRegistrationGuards.set(store, guard)
    }
    return guard
  }

  protected isCurrentRepoRegistration(repo: Repo): boolean {
    return this.repoRegistrationGuard()(repo, getRepoExecutionHostId(repo))
  }

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
    const repos = this.store.getRepos().map((repo) => ({ ...repo }))
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const ownerCounts = new Map<string, number>()
    for (const repo of repos) {
      ownerCounts.set(repo.id, (ownerCounts.get(repo.id) ?? 0) + 1)
    }
    const deps = this.repoWorktreeRowDeps(repos)
    const perRepoWorktrees = await Promise.all(
      repos.map(async (repo) => ({
        repo,
        worktrees: await resolveRepoWorktreeRows(
          deps,
          repo,
          metaById,
          projectRuntimeByRepoId,
          ownerCounts.get(repo.id) ?? 0
        )
      }))
    )
    const currentRepoWorktrees = perRepoWorktrees.filter(({ repo }) => deps.isRepoCurrent?.(repo))
    const platformByRepoId = new Map(
      currentRepoWorktrees.map(({ repo }) => [
        repo.id,
        getAgentLaunchPlatformForRepo(repo, projectRuntimeByRepoId.get(repo.id))
      ])
    )
    const lineageById = this.store?.getAllWorktreeLineage?.() ?? {}
    const worktrees = currentRepoWorktrees.flatMap(({ worktrees: rows }) =>
      projectResolvedWorktreeLineage(rows, lineageById)
    )
    return { worktrees, platformByRepoId }
  }

  /** Bind the runtime-owned scan cache and folder-workspace stamping into the row resolver. */
  protected repoWorktreeRowDeps(initialRepos?: readonly Repo[]): RepoWorktreeRowDeps {
    const store = this.requireStore()
    const isRepoCurrent = this.repoRegistrationGuard(initialRepos)
    return {
      store,
      isRepoCurrent: (repo) => isRepoCurrent(repo, getRepoExecutionHostId(repo)),
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
    const scan = await this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
    return scan.ok && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? { ok: true, worktrees: await withUnregisteredRemovalCheckouts(repo.id, scan.worktrees) }
      : scan
  }

  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const capturedRepo = { ...repo }
    const hostId = getRepoExecutionHostId(capturedRepo)
    const isRepoCurrent = this.repoRegistrationGuard()
    const isCurrent = () => isRepoCurrent(capturedRepo, hostId)
    if (!isCurrent()) {
      return { ok: false, worktrees: [] }
    }
    // Resolve the execution host, not the raw field: an `executionHostId: 'ssh:*'` row with no
    // `connectionId` would otherwise get a local project runtime and a `local:default` cache key,
    // so its scan neither routes remotely nor re-runs when the SSH provider is replaced.
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
        ? `ssh:${sshConnectionId}:${getSshGitProviderGeneration(sshConnectionId)}`
        : 'local:default'
    const now = Date.now()
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scanScopeKey) ?? 0
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      isRepoCurrent(cached.repo, hostId) &&
      cached.expiresAt > now
    ) {
      return cached.result
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (
      inFlight?.generation === generation &&
      inFlight.runtimeKey === runtimeKey &&
      isRepoCurrent(inFlight.repo, hostId)
    ) {
      const refresh = await inFlight.promise
      if (!isCurrent()) {
        return { ok: false, worktrees: [] }
      }
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      return refresh.result
    }
    const reusableCached =
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      isRepoCurrent(cached.repo, hostId)
        ? cached
        : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
    this.worktreeScanInFlight.set(scanScopeKey, {
      repo: capturedRepo,
      generation,
      runtimeKey,
      promise
    })
    try {
      const refresh = await promise
      if (!isCurrent()) {
        return { ok: false, worktrees: [] }
      }
      if (generation !== (this.worktreeScanGenerations.get(scanScopeKey) ?? 0)) {
        return this.listRepoWorktreesForResolution(repo, projectRuntimeByRepoId)
      }
      if (
        (refresh.result.ok || !sshConnectionId) &&
        this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise
      ) {
        const entry: RuntimeWorktreeScanCache = {
          repo: capturedRepo,
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
