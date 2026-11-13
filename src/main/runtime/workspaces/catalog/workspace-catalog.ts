import { OrcaRuntimeWithReadKittyFile } from '../../files/paths/orca-runtime-read-kitty-file'
import type { RuntimeWorkspaceRepoScanRefresh } from './workspace-repo-scan-refresh'
import {
  listKnownResolvedWorktreesForExplicitTarget,
  type ResolvedWorktree
} from './runtime-worktree-path-identity'
import type { ResolvedWorktreeSnapshot } from './runtime-resolved-worktree-cache'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'

import { getWorktreeScanMutationRevision } from '../../../workspaces/catalog/local-worktree-scan-generation'
import { resolveLocalProjectRuntimesForRepos } from '../../../workspaces/execution-host/local-project-runtime-resolution'
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
import {
  listRuntimeFolderWorkspaces,
  projectRuntimeFolderWorkspaces
} from './runtime-worktree-filesystem'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { RuntimeWorktreeScanAttempt } from './repo-worktree-resolution-scan'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeWorktreeScanCache } from './runtime-worktree-scan-state'
import * as ScanCache from './runtime-worktree-scan-cache'
import {
  captureRuntimeWorktreeScanOwner,
  runtimeWorktreeScanOwnerKey,
  listRuntimeRepoWorktreesForListing,
  type RuntimeWorktreeListingOptions,
  type WitnessedRuntimeWorktreeScan
} from './runtime-witnessed-worktree-scan'
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000

export abstract class RuntimeWorkspaceCatalog extends OrcaRuntimeWithReadKittyFile {
  protected abstract refreshRepoWorktreeScan(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>
  ): ReturnType<RuntimeWorkspaceRepoScanRefresh['refreshRepoWorktreeScan']>

  protected listKnownResolvedWorktreesForExplicitTarget(
    targetWorktreeId: string,
    targetWorktree: ResolvedWorktree | null
  ): ResolvedWorktree[] {
    return listKnownResolvedWorktreesForExplicitTarget(
      this.store,
      (worktreeId, repos) => this.buildResolvedWorktreeFromId(worktreeId, repos),
      targetWorktreeId,
      targetWorktree
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
    const repoOwners = createRepoRowExecutionHostLookup(repos)
    const projectRuntimeByRepoId = resolveLocalProjectRuntimesForRepos(this.requireStore(), repos)
    const platformByRepoId = platformsByRepoId(repos, projectRuntimeByRepoId)
    const deps = this.repoWorktreeRowDeps()
    const perRepoWorktrees = await Promise.all(
      repos.map(
        async (repo) =>
          await resolveRepoWorktreeRows(
            deps,
            repo,
            metaById,
            projectRuntimeByRepoId,
            repoOwners.rowsFor(repo.id).length
          )
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
    const registered = new Set(
      (this.store?.getRepos() ?? []).map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}`)
    )
    for (const cache of [
      this.worktreeScanCache,
      this.worktreeScanGenerations,
      this.worktreeScanInFlight
    ]) {
      for (const key of cache.keys()) {
        if (!registered.has(key)) {
          cache.delete(key)
        }
      }
    }
  }

  /** The fleet listing from cached scans and the store as it is now, synchronously. */
  protected joinResolvedWorktreeScans(scans: ResolvedWorktreeRepoScans): ResolvedWorktreeScanJoin {
    return joinResolvedWorktreeScans(
      this.store,
      () => ({
        ...this.repoWorktreeRowDeps(),
        listFolderWorkspaces: (repo, count) =>
          projectRuntimeFolderWorkspaces(this.requireStore(), repo, count)
      }),
      scans
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
          cached.runtimeKey === runtimeWorktreeScanOwnerKey(store, repo) &&
          cached.listing?.ok &&
          cached.listing.isCurrent()
        ) {
          return cached.listing
        }
        return undefined
      },
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

  /** One bounded attempt sequence owns raw resolution and removal-checkout delivery together. */
  protected async listRepoWorktreesForListing(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
    options: RuntimeWorktreeListingOptions = {}
  ): Promise<WitnessedRuntimeWorktreeScan> {
    const store = this.requireStore()
    return listRuntimeRepoWorktreesForListing({
      store,
      repo: { ...repo },
      scanRepo: (current, initialAttempt) =>
        this.listRepoWorktreesForResolution(
          current,
          initialAttempt ? projectRuntimeByRepoId : undefined
        ),
      cache: this.worktreeScanCache,
      generations: this.worktreeScanGenerations,
      isCurrentRuntime: () => this.store === store,
      options
    })
  }

  /** Raw topology is one attempt; listing and structured callers own their separate retry bounds. */
  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanAttempt> {
    repo = { ...repo }
    const store = this.requireStore()
    const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, repo)
    const {
      projectRuntime,
      runtimeKey: projectRuntimeKey,
      sshConnectionId
    } = ScanCache.resolveWorktreeScanRuntime(store, repo, projectRuntimeByRepoId)
    const runtimeKey = runtimeWorktreeScanOwnerKey(store, repo)
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scanScopeKey) ?? 0
    const isCurrent = () =>
      this.store === store &&
      ownerIsCurrent() &&
      (this.worktreeScanGenerations.get(scanScopeKey) ?? 0) === generation &&
      ScanCache.resolveWorktreeScanRuntime(store, repo).runtimeKey === projectRuntimeKey
    const superseded = (): RuntimeWorktreeScanAttempt => ({
      ok: false,
      worktrees: [],
      superseded: true
    })
    if (!isCurrent()) {
      return superseded()
    }
    const cached = this.worktreeScanCache.get(scanScopeKey)
    if (
      cached?.generation === generation &&
      cached.runtimeKey === runtimeKey &&
      cached.expiresAt > Date.now()
    ) {
      return cached.result
    }
    const finish = (result: RuntimeWorktreeScanAttempt, promise: Promise<unknown>) => {
      const flight = this.worktreeScanInFlight.get(scanScopeKey)
      const entry = this.worktreeScanCache.get(scanScopeKey)
      return isCurrent() &&
        (!flight || flight.promise === promise) &&
        (entry === cached || entry?.result === result)
        ? result
        : superseded()
    }
    const inFlight = this.worktreeScanInFlight.get(scanScopeKey)
    if (inFlight?.generation === generation && inFlight.runtimeKey === runtimeKey) {
      return finish((await inFlight.promise).result, inFlight.promise)
    }
    const reusableCached =
      cached?.generation === generation && cached.runtimeKey === runtimeKey ? cached : null
    const promise = this.refreshRepoWorktreeScan(repo, projectRuntime, reusableCached)
      .then((refresh) => {
        const accepts = () =>
          isCurrent() &&
          this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise &&
          (!refresh.observationCommit || refresh.observationCommit.isCurrent())
        if (refresh.result.superseded || !accepts()) {
          return { ...refresh, result: superseded() }
        }
        if (refresh.result.ok) {
          refresh.observationCommit?.commit(refresh.result.worktrees)
        }
        if (!accepts()) {
          return { ...refresh, result: superseded() }
        }
        const result = { ...refresh.result, superseded: false, isCurrent }
        if (result.ok || !sshConnectionId) {
          const entry: RuntimeWorktreeScanCache = {
            generation,
            runtimeKey,
            result,
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
        return { ...refresh, result }
      })
      .finally(() => {
        if (this.worktreeScanInFlight.get(scanScopeKey)?.promise === promise) {
          this.worktreeScanInFlight.delete(scanScopeKey)
        }
      })
    this.worktreeScanInFlight.set(scanScopeKey, { generation, runtimeKey, promise })
    return finish((await promise).result, promise)
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }
}
