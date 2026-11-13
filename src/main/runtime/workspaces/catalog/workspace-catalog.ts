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
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import type { RuntimeWorktreeScanAttempt } from './repo-worktree-resolution-scan'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  peekWorktreeCatalog,
  retireObsoleteWorktreeCatalogs
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import {
  claimRuntimeLineagePrune,
  runtimeResultForObservation,
  runtimeWorktreeListingFor
} from './runtime-worktree-catalog-read'
import * as ScanCache from './runtime-worktree-scan-cache'
import {
  captureRuntimeWorktreeScanOwner,
  listRuntimeRepoWorktreesForListing,
  type RuntimeWorktreeListingOptions,
  type WitnessedRuntimeWorktreeScan
} from './runtime-witnessed-worktree-scan'
const RESOLVED_WORKTREE_CACHE_TTL_MS = 1000

export abstract class RuntimeWorkspaceCatalog extends OrcaRuntimeWithReadKittyFile {
  protected abstract readRepoWorktreeCatalog(
    ...args: Parameters<RuntimeWorkspaceRepoScanRefresh['readRepoWorktreeCatalog']>
  ): ReturnType<RuntimeWorkspaceRepoScanRefresh['readRepoWorktreeCatalog']>

  protected abstract listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[]

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
    return scanResolvedWorktreeRepos(
      this.store,
      this.repoWorktreeRowDeps.bind(this),
      (repo) => this.peekRepoWorktreeObservation(repo)?.observation
    )
  }

  protected pruneUnregisteredWorktreeScans(): void {
    retireObsoleteWorktreeCatalogs()
  }

  private peekRepoWorktreeObservation(repo: Repo) {
    return this.store
      ? peekWorktreeCatalog(repo, ScanCache.resolveWorktreeScanRuntime(this.store, repo).runtimeKey)
      : null
  }

  /** The listing a client last saw for this repo, current or not, for path spelling. */
  protected peekRepoWorktreeListing(repo: Repo): RuntimeWorktreeScanAttempt | undefined {
    const known = this.peekRepoWorktreeObservation(repo)
    if (!known) {
      return undefined
    }
    const result = runtimeResultForObservation(known.observation)
    return runtimeWorktreeListingFor(result) ?? result
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
        const known = this.peekRepoWorktreeObservation(repo)
        const listing = known?.current
          ? runtimeWorktreeListingFor(runtimeResultForObservation(known.observation))
          : undefined
        return listing?.ok && (!listing.isCurrent || listing.isCurrent()) ? listing : undefined
      },
      claimLineagePrune: claimRuntimeLineagePrune,
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
          initialAttempt ? projectRuntimeByRepoId : undefined,
          options
        ),
      isCurrentRuntime: () => this.store === store,
      options
    })
  }

  /** Raw topology is one attempt; listing and structured callers own their separate retry bounds. */
  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
    options: RuntimeWorktreeListingOptions = {}
  ): Promise<RuntimeWorktreeScanAttempt> {
    repo = { ...repo }
    const store = this.requireStore()
    const ownerIsCurrent = captureRuntimeWorktreeScanOwner(store, repo)
    const { projectRuntime, runtimeKey, sshConnectionId } = ScanCache.resolveWorktreeScanRuntime(
      this.requireStore(),
      repo,
      projectRuntimeByRepoId
    )
    // Why: this process serves no SSH git, so an SSH repo answers from its stored rows.
    if (sshConnectionId) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    if (!ownerIsCurrent()) {
      return { ok: false, worktrees: [], superseded: true }
    }
    const result = await this.readRepoWorktreeCatalog(
      repo,
      projectRuntime,
      runtimeKey,
      options.captureMetadataPruneExpectation === true
    )
    return this.store === store && ownerIsCurrent()
      ? result
      : { ok: false, worktrees: [], superseded: true }
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }
}
