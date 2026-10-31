import { toRuntimeDetectedWorktree, runtimeVisibilityDefaults } from './runtime-worktree-visibility'
import { knownWorktreeInventory } from '../known-worktree-inventory'
import { canonicalWorktreePath } from '../git/worktree-path-comparison'
import type { DetectedWorktreeListResult, Worktree } from '../../shared/worktree/types'
import {
  runtimeHiddenHostIds,
  runtimeHiddenRepos,
  withoutHiddenHosts
} from './runtime-visible-catalog'
import {
  getLocalWorktreeCatalogVersion,
  localWorktreeCatalogVersionAt
} from '../local-worktree-scan-generation'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { buildWorktreeListingPage, listingKnownHostIds } from './worktree-listing-host-scope'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import { isFolderRepo } from '../../shared/repo-kind'
import { applyMetadataFallbackVisibility } from '../../shared/worktree/ownership'
import { projectWorktreeLineageWithHostPeers } from '../worktree-lineage-host-peers'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../shared/worktree/visibility-sources'
import { mergeWorktree } from '../ipc/worktree-metadata-merge'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import {
  canPruneAuthoritativeLocalMetadata,
  pruneMetadataMissingFromAuthoritativeLocalScan
} from '../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import type { RuntimeStore } from './runtime-store-contract'
import { getWorkspaceAttachments } from '../../shared/workspace-attachments'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { scanRuntimeWorktreesUntilNotOvertaken } from './runtime-witnessed-worktree-scan'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import {
  getRetiredNameRegistryForRepo,
  hasRetiredNameRegistryStore
} from '../worktree-name-retirement'

type Dependencies = {
  getStore(): RuntimeStore | null
  listResolved(): Promise<ResolvedWorktree[]>
  resolveRepo(selector: string): Promise<Repo>
  selectRepos(selector: string): Repo[]
  scanRepo(repo: Repo): Promise<RuntimeWorktreeScanResult>
  /** Hosts this runtime has repos or workspaces on, so a host with no rows is still named. */
  listKnownHostIds(): Iterable<ExecutionHostId>
}

export class RuntimeManagedWorktreeQueries {
  constructor(private readonly deps: Dependencies) {}

  async list(
    repoSelector: string | undefined,
    limit: number,
    sourceDefaultsSupported = true
  ): Promise<RuntimeWorktreeListResult> {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error('invalid_limit')
    }
    const resolved = await this.deps.listResolved()
    const scopedRepo = repoSelector ? await this.deps.resolveRepo(repoSelector) : null
    const pathsByRepo = new Map<string, string[]>()
    for (const worktree of resolved) {
      const paths = pathsByRepo.get(worktree.repoId) ?? []
      paths.push(worktree.path)
      pathsByRepo.set(worktree.repoId, paths)
    }
    const visibilityDefaults = this.visibilityDefaults(sourceDefaultsSupported)
    const matchers = new Map(
      (this.deps.getStore()?.getRepos() ?? []).map((repo) => [
        repo.id,
        createWorktreeVisibilitySourceMatcher(
          [repo.path, ...(pathsByRepo.get(repo.id) ?? [])],
          resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
          resolveConfiguredWorktreeBasePaths(repo)
        )
      ])
    )
    const hiddenRepos = runtimeHiddenRepos(this.deps.getStore())
    const worktrees = resolved.filter(
      (worktree) =>
        !hiddenRepos.hasWorktree(worktree) &&
        (!scopedRepo || worktree.repoId === scopedRepo.id) &&
        this.isVisible(worktree, matchers.get(worktree.repoId), sourceDefaultsSupported)
    )
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

  async listDetected(
    repo: Repo,
    sourceDefaultsSupported = true
  ): Promise<DetectedWorktreeListResult> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    const settings = store.getSettings()
    const visibilityDefaults = this.visibilityDefaults(sourceDefaultsSupported)
    const visibilitySettings = { ...settings, worktreeVisibilityDefaults: visibilityDefaults }
    if (isFolderRepo(repo)) {
      const worktrees = listRuntimeFolderWorkspaces(store, repo)
      const metaById = store.getAllWorktreeMeta()
      const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
      const matcher = createWorktreeVisibilitySourceMatcher(
        [repo.path, ...worktrees.map((worktree) => worktree.path)],
        resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
        resolveConfiguredWorktreeBasePaths(repo)
      )
      const detected = worktrees.map((worktree) =>
        toRuntimeDetectedWorktree(
          this.deps.getStore(),
          repo,
          worktree,
          matcher,
          sourceDefaultsSupported,
          visibilitySettings,
          getRepoOwnedWorktreeMeta(repo, worktree.id, metaById, repoOwnerCount) ?? null
        )
      )
      return {
        repoId: repo.id,
        authoritative: true,
        source: 'git',
        catalogVersion: getLocalWorktreeCatalogVersion(repo.id),
        worktrees: projectWorktreeLineageWithHostPeers(store, repo, detected)
      }
    }
    const scan = await scanRuntimeWorktreesUntilNotOvertaken(store, repo, (target) =>
      this.deps.scanRepo(target)
    )
    // Publish overtaken scans as non-authoritative: throwing would drop client rows. Prune nothing; the overtaking mutation's event requests a fresh listing.
    if (scan.ok && !scan.superseded) {
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
      if (scan.isCurrent?.() !== false) {
        pruneLineageForMissingRepoWorktrees(store, repo, scan.worktrees)
      }
    }
    const superseded = scan.superseded || scan.isCurrent?.() === false
    // Superseded positives may carry current saved owners, but never a completed deletion.
    const owners = superseded
      ? new Set(
          knownWorktreeInventory(store)
            .read(repo)
            .paths.map((row) => canonicalWorktreePath(row.path))
        )
      : null
    if (
      owners &&
      store
        .getRepos()
        .some(
          (current) =>
            current.id === repo.id &&
            getRepoExecutionHostId(current) === getRepoExecutionHostId(repo) &&
            current.path === repo.path
        )
    ) {
      owners.add(canonicalWorktreePath(repo.path))
    }
    const worktrees = owners
      ? scan.worktrees.filter((row) => owners.has(canonicalWorktreePath(row.path)))
      : scan.worktrees
    const matcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...worktrees.map((worktree) => worktree.path)],
      resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
      resolveConfiguredWorktreeBasePaths(repo)
    )
    const expectedHostId = getRepoExecutionHostId(repo)
    const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
    const metaById = store.getAllWorktreeMeta()
    const detected = worktrees.map((gitWorktree) => {
      const id = `${repo.id}::${gitWorktree.path}`
      const meta =
        readWorktreeMetaForHost(store, id, expectedHostId) ??
        getRepoOwnedWorktreeMeta(repo, id, metaById, repoOwnerCount)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: repoOwnerCount === 1 ? (meta?.hostId ?? expectedHostId) : expectedHostId
      }
      const result = toRuntimeDetectedWorktree(
        this.deps.getStore(),
        repo,
        worktree,
        matcher,
        sourceDefaultsSupported,
        visibilitySettings,
        meta ?? null
      )
      return scan.ok ? result : applyMetadataFallbackVisibility(result)
    })
    return {
      repoId: repo.id,
      authoritative: scan.ok && !superseded,
      source: scan.ok ? 'git' : 'metadata-fallback',
      // Stamp the scan's starting generation: that is the catalog its rows describe.
      catalogVersion: localWorktreeCatalogVersionAt(scan.scanGeneration),
      worktrees: projectWorktreeLineageWithHostPeers(store, repo, detected)
    }
  }

  isVisible(
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher,
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): boolean {
    const repo = this.deps.getStore()?.getRepo(worktree.repoId)
    return repo
      ? toRuntimeDetectedWorktree(
          this.deps.getStore(),
          repo,
          worktree,
          matcher,
          sourceDefaultsSupported,
          providedSettings
        ).visible
      : true
  }

  buildVisibilityMatchers(
    worktrees: readonly Worktree[],
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ): Map<string, WorktreeVisibilitySourceMatcher> {
    const checkoutPathsByRepoId = new Map<string, string[]>()
    for (const worktree of worktrees) {
      const checkoutPaths = checkoutPathsByRepoId.get(worktree.repoId) ?? []
      checkoutPaths.push(worktree.path)
      checkoutPathsByRepoId.set(worktree.repoId, checkoutPaths)
    }
    const visibilityDefaults = this.visibilityDefaults(sourceDefaultsSupported, providedSettings)
    return new Map(
      (this.deps.getStore()?.getRepos() ?? [])
        .filter((repo) => checkoutPathsByRepoId.has(repo.id))
        .map((repo) => [
          repo.id,
          createWorktreeVisibilitySourceMatcher(
            [repo.path, ...(checkoutPathsByRepoId.get(repo.id) ?? [])],
            resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
            resolveConfiguredWorktreeBasePaths(repo)
          )
        ])
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

  private visibilityDefaults(
    sourceDefaultsSupported: boolean,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ) {
    return runtimeVisibilityDefaults(
      sourceDefaultsSupported,
      providedSettings ?? this.deps.getStore()?.getSettings()
    )
  }
}
