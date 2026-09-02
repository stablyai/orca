import type { DetectedWorktreeListResult, Worktree } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-types'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { readWorktreeMetaForHost } from '../persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from '../worktree-metadata-ownership'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { isFolderRepo } from '../../shared/repo-kind'
import {
  applyMetadataFallbackVisibility,
  buildKnownOrcaWorkspaceLayouts,
  isLegacyRepoForExternalWorktreeVisibility,
  toDetectedWorktree
} from '../../shared/worktree/ownership'
import { projectResolvedWorktreeLineage } from '../../shared/resolved-worktree-lineage'
import {
  createWorktreeVisibilitySourceMatcher,
  resolveCustomWorktreeVisibilitySources,
  type WorktreeVisibilitySourceMatcher
} from '../../shared/worktree/visibility-sources'
import { mergeWorktree } from '../ipc/worktree-logic'
import { pruneLineageForMissingRepoWorktrees } from '../worktree-lineage-pruning'
import { pruneMetadataMissingFromAuthoritativeLocalScan } from '../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning'
import type { NativeLocalWorktreeMetadataScanExpectation } from '../persistence/tracking-repos/missing-local-worktree-metadata-pruning'
import { getLocalWorktreeScanGeneration } from '../local-worktree-scan-generation'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import type { Store } from '../persistence'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { listRuntimeFolderWorkspaces } from './runtime-worktree-filesystem'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { resolveConfiguredWorktreeBasePaths } from '../../shared/worktree/configured-worktree-base-path'
import { getRetiredNameRegistryForRepo } from '../worktree-name-retirement'

type Dependencies = {
  getStore(): RuntimeStore | null
  listResolved(): Promise<ResolvedWorktree[]>
  resolveRepo(selector: string): Promise<Repo>
  selectRepos(selector: string): Repo[]
  scanRepo(repo: Repo): Promise<RuntimeWorktreeScanResult>
}

/**
 * The destructive scan expectation for one repo, or undefined when this repo must not carry one.
 *
 * WSL-routed repos are excluded for the same reason the desktop listing excludes them: the listing
 * runs in the distro and reports Linux paths while metadata can hold UNC ones, and v1 cannot prove
 * those aliases equivalent. A runtime that needs repair throws rather than resolving routing, which
 * is likewise no basis for deleting rows.
 */
function captureLocalMetadataPruneExpectation(
  store: RuntimeStore,
  repo: Repo
): NativeLocalWorktreeMetadataScanExpectation | undefined {
  if (typeof store.captureNativeLocalWorktreeMetadataScanExpectation !== 'function') {
    return undefined
  }
  try {
    if (getLocalProjectWorktreeGitOptions(store as unknown as Store, repo).wslDistro) {
      return undefined
    }
  } catch {
    return undefined
  }
  return store.captureNativeLocalWorktreeMetadataScanExpectation(repo)
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
    const repoId = repoSelector ? (await this.deps.resolveRepo(repoSelector)).id : null
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
    const worktrees = resolved.filter(
      (worktree) =>
        (!repoId || worktree.repoId === repoId) &&
        this.isVisible(worktree, matchers.get(worktree.repoId), sourceDefaultsSupported)
    )
    return {
      worktrees: worktrees.slice(0, limit),
      totalCount: worktrees.length,
      truncated: worktrees.length > limit
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
        this.toDetected(
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
        worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
      }
    }
    // Why capture before the scan: listing can mutate metadata synchronously before its first
    // await, and the prune revalidates against the rows as they stood when the scan was issued.
    const metadataScanGeneration = getLocalWorktreeScanGeneration(repo.id)
    const metadataPruneExpectation = captureLocalMetadataPruneExpectation(store, repo)
    let scan: RuntimeWorktreeScanResult
    try {
      scan = await this.deps.scanRepo(repo)
    } catch {
      scan = { ok: false, worktrees: [] }
    }
    if (scan.ok) {
      // Why the runtime sweeps too: the desktop listing that used to own this runs off `ipcMain`,
      // so a headless host -- which has no renderer -- never pruned its own repos' rows (#17776).
      if (metadataPruneExpectation) {
        await pruneMetadataMissingFromAuthoritativeLocalScan({
          store: store as unknown as Store,
          repo,
          gitWorktrees: scan.worktrees,
          scan: metadataPruneExpectation,
          scanGeneration: metadataScanGeneration
        })
      }
      pruneLineageForMissingRepoWorktrees(store as unknown as Store, repo, scan.worktrees)
    }
    const matcher = createWorktreeVisibilitySourceMatcher(
      [repo.path, ...scan.worktrees.map((worktree) => worktree.path)],
      resolveCustomWorktreeVisibilitySources(repo, visibilityDefaults),
      resolveConfiguredWorktreeBasePaths(repo)
    )
    const expectedHostId = getRepoExecutionHostId(repo)
    const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
    const metaById = store.getAllWorktreeMeta()
    const detected = scan.worktrees.map((gitWorktree) => {
      const id = `${repo.id}::${gitWorktree.path}`
      const meta =
        readWorktreeMetaForHost(store as unknown as Store, id, expectedHostId) ??
        getRepoOwnedWorktreeMeta(repo, id, metaById, repoOwnerCount)
      const worktree = {
        ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
        hostId: repoOwnerCount === 1 ? (meta?.hostId ?? expectedHostId) : expectedHostId
      }
      const result = this.toDetected(
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
      authoritative: scan.ok,
      source: scan.ok ? 'git' : 'metadata-fallback',
      worktrees: projectResolvedWorktreeLineage(detected, store.getAllWorktreeLineage?.() ?? {})
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
      ? this.toDetected(repo, worktree, matcher, sourceDefaultsSupported, providedSettings).visible
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

  private toDetected(
    repo: Repo,
    worktree: Worktree,
    matcher?: WorktreeVisibilitySourceMatcher,
    sourceDefaultsSupported = true,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>,
    providedMeta?: WorktreeMeta | null
  ) {
    const store = this.deps.getStore()
    const settings = providedSettings ?? store?.getSettings()
    if (!settings) {
      return {
        ...worktree,
        ownership: 'unknown-legacy' as const,
        selectedCheckout: false,
        visible: true
      }
    }
    const visibilityDefaults = this.visibilityDefaults(sourceDefaultsSupported, settings)
    return toDetectedWorktree({
      repo,
      worktree,
      meta:
        providedMeta === undefined
          ? store?.getWorktreeMeta(worktree.id)
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
    if (!store?.getRetiredWorktreeNameRegistry || !store.mergeRetiredWorktreeNames) {
      return { retiredNamesByRepo: {}, retiredNameTiersByRepo: {} }
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const settings = store.getSettings()
    const registry = await getRetiredNameRegistryForRepo(
      store as never,
      repo,
      store.getRepos(),
      settings
    )
    return {
      retiredNamesByRepo: { [repo.id]: registry.names },
      retiredNameTiersByRepo: { [repo.id]: registry.exhaustedTiers }
    }
  }

  private visibilityDefaults(
    sourceDefaultsSupported: boolean,
    providedSettings?: ReturnType<RuntimeStore['getSettings']>
  ) {
    const defaults =
      providedSettings !== undefined
        ? providedSettings.worktreeVisibilityDefaults
        : this.deps.getStore()?.getSettings().worktreeVisibilityDefaults
    return sourceDefaultsSupported || !defaults ? defaults : { external: defaults.external }
  }
}
