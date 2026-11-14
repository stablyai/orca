import { readRuntimeListingMetadata, readRuntimeWorktreeMetadata } from './runtime-listing-metadata'
import type { RuntimeManagedWorktreeQueryDependencies } from './runtime-managed-worktree-query-dependencies'
import { resolveWorktreeHostRouting } from './worktree-launch-host-repo'
import { createRepoRowExecutionHostLookup } from '../../../../shared/execution-host/worktree-execution-host-resolution'
import { buildRuntimeWorktreeVisibilityMatchers } from './runtime-worktree-visibility'
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
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  toDetectedWorktree
} from '../../../../shared/worktree/visibility/ownership'
import { isLegacyRepoForExternalWorktreeVisibility } from '../../../../shared/external-worktree-visibility'
import { projectWorktreeLineageWithHostPeers } from '../../../workspaces/catalog/worktree-lineage-host-peers'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../../../shared/worktree/visibility/visibility-sources'
import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../../../workspaces/catalog/worktree-lineage-pruning'
import {
  canPruneAuthoritativeLocalMetadata,
  pruneMetadataMissingFromAuthoritativeLocalScan
} from '../../../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments/workspace-attachments'
import { scanRuntimeWorktreesUntilNotOvertaken } from './runtime-witnessed-worktree-scan'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import { resolveConfiguredWorktreeBasePaths } from '../../../../shared/worktree/paths/configured-worktree-base-path'
import {
  getRetiredNameRegistryForRepo,
  hasRetiredNameRegistryStore
} from '../../../workspaces/removal/retirement/worktree-name-retirement'

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
      this.visibilityDefaults(defaultsSupported)
    )
    const hiddenRepos = runtimeHiddenRepos(this.deps.getStore())
    const worktrees = resolved.filter((worktree) => {
      const routing = resolveWorktreeHostRouting(repos, worktree, repoLookup)
      if (hiddenRepos.hasWorktree(worktree) || routing.kind === 'ambiguous') {
        return false
      }
      if (routing.kind !== 'resolved' || !routing.repo) {
        return !scopedRepo
      }
      if (
        scopedRepo &&
        (worktree.repoId !== scopedRepo.id || routing.hostId !== getRepoExecutionHostId(scopedRepo))
      ) {
        return false
      }
      return this.toDetected(
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
    const visibilityDefaults = this.visibilityDefaults(defaultsSupported)
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
        this.toDetected(
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
    const scan = await scanRuntimeWorktreesUntilNotOvertaken(store, repo, this.deps.scanRepo)
    // Publish overtaken scans as non-authoritative: throwing would drop client rows. Prune nothing; the overtaking mutation's event requests a fresh listing.
    if (scan.ok && !scan.superseded && scan.authorityCurrent()) {
      // Headless hosts lack ipcMain listings; runtime must sweep its own metadata too (#17776).
      if (scan.metadataPruneExpectation && canPruneAuthoritativeLocalMetadata(store)) {
        await pruneMetadataMissingFromAuthoritativeLocalScan({
          store,
          repo,
          gitWorktrees: scan.worktrees,
          scan: scan.metadataPruneExpectation,
          scanGeneration: scan.scanGeneration,
          isCallerCurrent: scan.authorityCurrent
        })
      }
      if (scan.lineagePrune && scan.authorityCurrent()) {
        pruneLineageForMissingRepoWorktrees(store, repo, scan.worktrees, scan.lineagePrune)
      }
    }
    const matcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...scan.worktrees.map((worktree) => worktree.path)],
      resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
      resolveConfiguredWorktreeBasePaths(repo)
    )
    const expectedHostId = getRepoExecutionHostId(repo)
    const listed = readRuntimeListingMetadata(store, repo)
    const repoOwnerCount = listed.repoOwnerCount
    const detected = scan.worktrees.map((gitWorktree) => {
      const id = `${repo.id}::${gitWorktree.path}`
      const meta = readWorktreeMetaForHost(store, id, expectedHostId) ?? listed.ownedMeta(id)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: repoOwnerCount === 1 ? (meta?.hostId ?? expectedHostId) : expectedHostId
      }
      const result = this.toDetected(
        repo,
        worktree,
        matcher,
        defaultsSupported,
        visibilitySettings,
        meta ?? null
      )
      return scan.ok ? result : applyMetadataFallbackVisibility(result)
    })
    return {
      repoId: repo.id,
      authoritative: scan.ok && !scan.superseded && scan.authorityCurrent(),
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
    const routing = resolveWorktreeHostRouting<Repo>([], worktree, repoLookup)
    const repo = routing.kind === 'resolved' ? routing.repo : undefined
    return repo
      ? this.toDetected(
          repo,
          worktree,
          matcher,
          defaultsSupported,
          settingsOverride,
          undefined,
          repoLookup.rowsFor(repo.id).length
        ).visible
      : true
  }

  buildVisibilityMatchers(
    worktrees: readonly Worktree[],
    defaultsSupported = true,
    settingsOverride?: ReturnType<RuntimeStore['getSettings']>
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    return buildRuntimeWorktreeVisibilityMatchers(
      this.deps.getStore()?.getRepos() ?? [],
      worktrees,
      this.visibilityDefaults(defaultsSupported, settingsOverride)
    )
  }

  private toDetected(
    repo: Repo,
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher,
    defaultsSupported = true,
    settingsOverride?: ReturnType<RuntimeStore['getSettings']>,
    providedMeta?: WorktreeMeta | null,
    repoOwnerCount?: number
  ) {
    const store = this.deps.getStore()
    const settings = settingsOverride ?? store?.getSettings()
    if (!settings) {
      return {
        ...worktree,
        ownership: 'unknown-legacy' as const,
        selectedCheckout: false,
        visible: true
      }
    }
    const visibilityDefaults = this.visibilityDefaults(defaultsSupported, settings)
    return toDetectedWorktree({
      repo,
      worktree,
      meta:
        providedMeta === undefined
          ? store
            ? readRuntimeWorktreeMetadata(store, repo, worktree.id, repoOwnerCount)
            : undefined
          : (providedMeta ?? undefined),
      settings: { ...settings, worktreeVisibilityDefaults: visibilityDefaults },
      knownOrcaLayouts: buildKnownOrcaWorkspaceLayouts(settings, repo),
      isLegacyRepoForVisibility: isLegacyRepoForExternalWorktreeVisibility(repo),
      worktreeVisibilitySourceMatcher: matcher
    })
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

  private visibilityDefaults(
    defaultsSupported: boolean,
    settingsOverride?: ReturnType<RuntimeStore['getSettings']>
  ) {
    const defaults =
      settingsOverride !== undefined
        ? settingsOverride.worktreeVisibilityDefaults
        : this.deps.getStore()?.getSettings().worktreeVisibilityDefaults
    return defaultsSupported || !defaults ? defaults : { external: defaults.external }
  }
}
