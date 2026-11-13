import { readRuntimeListingMetadata } from './runtime-listing-metadata'
import type { RuntimeManagedWorktreeQueryDependencies } from './runtime-managed-worktree-query-dependencies'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import {
  buildRuntimeWorktreeVisibilityMatchers,
  isRuntimeWorktreeVisible,
  projectRuntimeDetectedWorktree,
  readRuntimeWorktreeVisibilityDefaults
} from './runtime-worktree-visibility'
import { getRepoHostIdentityForParts } from '../../../../shared/repo-host-identity'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import {
  runtimeHiddenHostIds,
  runtimeHiddenRepos,
  withoutHiddenHosts
} from './runtime-visible-catalog'
import {
  getLocalWorktreeCatalogVersion,
  localWorktreeCatalogVersionAt
} from '../../../workspaces/catalog/local-worktree-scan-generation'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../../../shared/runtime-worktree-contracts'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { buildWorktreeListingPage, listingKnownHostIds } from './worktree-listing-host-scope'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { applyMetadataFallbackVisibility } from '../../../../shared/worktree/ownership'
import { projectWorktreeLineageWithHostPeers } from '../../../workspaces/catalog/worktree-lineage-host-peers'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../../../shared/worktree/visibility-sources'
import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import {
  canPruneAuthoritativeLocalMetadata,
  pruneMetadataMissingFromAuthoritativeLocalScan
} from '../../../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import { currentRuntimeWorktreeScanRepo } from './runtime-witnessed-worktree-scan'
import { listStoredWorktreeRowsForRepo } from './repo-worktree-row-resolution'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/configured-worktree-base-path'
import {
  getRetiredNameRegistryForRepo,
  hasRetiredNameRegistryStore
} from '../../../workspaces/removal/retirement/worktree-name-retirement'
import {
  gitWorktreeObservationReader,
  isAdoptableGitWorktree
} from '../../../workspaces/catalog/git-worktree-observations'

export class RuntimeManagedWorktreeQueries {
  constructor(private readonly deps: RuntimeManagedWorktreeQueryDependencies) {}

  async list(
    repoSelector: string | undefined,
    limit: number,
    defaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.deps.listResolved()
    const scopedRepo = repoSelector ? await this.deps.resolveRepo(repoSelector) : null
    const repos = this.deps.getStore()?.getRepos() ?? []
    const repoLookup = createRepoRowExecutionHostLookup(repos)
    const matchers = buildRuntimeWorktreeVisibilityMatchers(
      repos,
      resolved,
      readRuntimeWorktreeVisibilityDefaults(() => this.deps.getStore(), defaultsSupported)
    )
    const hiddenRepos = runtimeHiddenRepos(this.deps.getStore())
    const worktrees = resolved.filter((worktree) => {
      if (worktree.git.prunable && !worktree.removalError) {
        return false
      }
      const routing = resolveWorktreeHostRouting(repos, worktree, repoLookup)
      if (hiddenRepos.hasWorktree(worktree) || routing.kind === 'ambiguous') {
        return false
      }
      if (routing.kind !== 'resolved' || !routing.repo) {
        return !worktree.isBare && !scopedRepo
      }
      if (
        !isFolderRepo(routing.repo) &&
        !worktree.instanceId &&
        !isAdoptableGitWorktree(worktree.git) &&
        !worktree.removalError
      ) {
        return false
      }
      if (
        scopedRepo &&
        (worktree.repoId !== scopedRepo.id || routing.hostId !== getRepoExecutionHostId(scopedRepo))
      ) {
        return false
      }
      return projectRuntimeDetectedWorktree(
        () => this.deps.getStore(),
        routing.repo,
        worktree,
        matchers.get(getRepoHostIdentityForParts(worktree.repoId, routing.hostId)),
        defaultsSupported,
        undefined,
        undefined,
        repoLookup.rowsFor(routing.repo.id).length
      ).visible
    })
    // Scoped reads must name requested hosts even without rows; hidden retained repos must never reenter scope.
    const knownHostIds = withoutHiddenHosts(
      listingKnownHostIds(scopedRepo, () => this.deps.listKnownHostIds()),
      runtimeHiddenHostIds(this.deps.getStore())
    )
    const page = buildWorktreeListingPage(worktrees, limit, knownHostIds)
    return {
      ...page,
      worktrees: page.worktrees.map((worktree) => ({
        ...worktree,
        linkedItems: getWorkspaceAttachments(worktree)
      }))
    }
  }

  resolveRepoForConnection(selector: string, connectionId?: string | null): Promise<Repo> {
    if (connectionId === undefined) {
      return this.deps.resolveRepo(selector)
    }
    const wanted = connectionId?.trim() || null
    const matches = this.deps
      .selectRepos(selector)
      .filter((repo) => (repo.connectionId?.trim() || null) === wanted)
    if (matches.length !== 1) {
      throw new Error(matches.length > 1 ? 'selector_ambiguous' : 'repo_not_found')
    }
    return Promise.resolve(matches[0])
  }

  async listDetected(repo: Repo, defaultsSupported = true): Promise<DetectedWorktreeListResult> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const settings = store.getSettings()
    const visibilityDefaults = readRuntimeWorktreeVisibilityDefaults(
      () => this.deps.getStore(),
      defaultsSupported
    )
    const visibilitySettings = { ...settings, worktreeVisibilityDefaults: visibilityDefaults }
    if (isFolderRepo(repo)) {
      const worktrees = listRuntimeFolderWorkspaces(store, repo)
      const listed = readRuntimeListingMetadata(store, repo)
      const matcher = createWorktreeVisibilitySourceMatcher(
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
      const detected = worktrees.map((worktree) =>
        projectRuntimeDetectedWorktree(
          () => this.deps.getStore(),
          repo,
          worktree,
          matcher,
          defaultsSupported,
          visibilitySettings,
          listed.ownedMeta(worktree.id) ?? null
        )
      )
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        workspaceMetadata: listed.workspaceMetadata,
        worktrees: projectWorktreeLineageWithHostPeers(store, repo, detected)
      }
    }
    repo = { ...repo }
    let scan = await this.deps.scanRepo(repo)
    repo = { ...(currentRuntimeWorktreeScanRepo(store, repo) ?? repo) }
    // Publish overtaken scans as non-authoritative: throwing would drop client rows. Prune nothing; the overtaking mutation's event requests a fresh listing.
    if (scan.ok && !scan.superseded && scan.isCurrent()) {
      // Headless hosts lack ipcMain listings; runtime must sweep its own metadata too (#17776).
      if (scan.metadataPruneExpectation && canPruneAuthoritativeLocalMetadata(store)) {
        await pruneMetadataMissingFromAuthoritativeLocalScan({
          store,
          repo,
          gitWorktrees: scan.worktrees,
          scan: scan.metadataPruneExpectation,
          scanGeneration: scan.scanGeneration,
          isCallerCurrent: scan.isCurrent
        })
      }
      if (scan.isCurrent()) {
        pruneLineageForMissingRepoWorktrees(store, repo, scan.worktrees)
      }
    }
    const current = currentRuntimeWorktreeScanRepo(store, repo)
    if (scan.superseded || !scan.isCurrent()) {
      scan = {
        ...scan,
        ok: false,
        superseded: true,
        worktrees: current ? listStoredWorktreeRowsForRepo(store, current) : []
      }
    }
    repo = current ?? repo
    const matcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...scan.worktrees.map((worktree) => worktree.path)],
      resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
      resolveConfiguredWorktreeBasePaths(repo)
    )
    const expectedHostId = getRepoExecutionHostId(repo)
    const listed = readRuntimeListingMetadata(store, repo)
    const repoOwnerCount = listed.repoOwnerCount
    const readObservation = gitWorktreeObservationReader(store, repo)
    const detected = scan.worktrees.map((gitWorktree) => {
      const id = `${repo.id}::${gitWorktree.path}`
      const meta = readWorktreeMetaForHost(store, id, expectedHostId) ?? listed.ownedMeta(id)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: repoOwnerCount === 1 ? (meta?.hostId ?? expectedHostId) : expectedHostId
      }
      const result = projectRuntimeDetectedWorktree(
        () => this.deps.getStore(),
        repo,
        worktree,
        matcher,
        defaultsSupported,
        visibilitySettings,
        meta ?? null
      )
      if (scan.ok && !meta && !isAdoptableGitWorktree(gitWorktree) && !gitWorktree.removalError) {
        return { ...result, visible: false }
      }
      const observation = readObservation(meta)
      if (scan.ok || observation) {
        return {
          ...result,
          visible: result.visible && (!gitWorktree.prunable || !!gitWorktree.removalError)
        }
      }
      return applyMetadataFallbackVisibility(result)
    })
    return {
      repoId: repo.id,
      authoritative: scan.ok && !scan.superseded,
      source: scan.ok ? 'git' : 'metadata-fallback',
      workspaceMetadata: listed.workspaceMetadata,
      // Stamp the scan's starting generation: that is the catalog its rows describe.
      catalogVersion: localWorktreeCatalogVersionAt(scan.scanGeneration),
      worktrees: projectWorktreeLineageWithHostPeers(store, repo, detected)
    }
  }

  isVisible(
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher,
    defaultsSupported = true,
    settingsOverride?: ReturnType<RuntimeStore['getSettings']>,
    repoLookup = createRepoRowExecutionHostLookup(this.deps.getStore()?.getRepos() ?? [])
  ): boolean {
    return isRuntimeWorktreeVisible(
      () => this.deps.getStore(),
      worktree,
      matcher,
      defaultsSupported,
      settingsOverride,
      repoLookup
    )
  }

  buildVisibilityMatchers(
    worktrees: readonly Worktree[],
    defaultsSupported = true,
    settingsOverride?: ReturnType<RuntimeStore['getSettings']>
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    return buildRuntimeWorktreeVisibilityMatchers(
      this.deps.getStore()?.getRepos() ?? [],
      worktrees,
      readRuntimeWorktreeVisibilityDefaults(
        () => this.deps.getStore(),
        defaultsSupported,
        settingsOverride
      )
    )
  }

  async listRetiredNames(repoSelector: string): Promise<{
    retiredNamesByRepo: Record<string, readonly string[]>
    retiredNameTiersByRepo: Record<string, number>
  }> {
    const store = this.deps.getStore()
    if (!store || !hasRetiredNameRegistryStore(store)) {
      return { retiredNamesByRepo: {}, retiredNameTiersByRepo: {} }
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const settings = store.getSettings()
    const registry = await getRetiredNameRegistryForRepo(store, repo, store.getRepos(), settings)
    return {
      retiredNamesByRepo: { [repo.id]: registry.names },
      retiredNameTiersByRepo: { [repo.id]: registry.exhaustedTiers }
    }
  }
}
