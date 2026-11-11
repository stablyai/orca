import { workspaceRootIsBare } from '../../../workspaces/catalog/workspace-git-storage'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { OrcaRuntimeWithReadKittyFile } from '../../files/paths/orca-runtime-read-kitty-file'
import type { RuntimeWorkspaceRepoScanRefresh } from './workspace-repo-scan-refresh'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
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
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
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
    const repos = createRepoRowExecutionHostLookup(this.store.getRepos())
    for (const worktreeId of worktreeIds) {
      const worktree =
        worktreeId === targetWorktreeId
          ? targetWorktree
          : this.buildResolvedWorktreeFromId(worktreeId, repos)
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
    ScanCache.pruneUnregisteredWorktreeScans(this.store, () => [
      this.worktreeScanCache,
      this.worktreeScanGenerations,
      this.worktreeScanInFlight
    ])
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
          cached.runtimeKey === ScanCache.resolveWorktreeScanRuntime(store, repo).runtimeKey &&
          cached.listing?.ok
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

  protected async listRepoWorktreesForResolution(
    repo: Repo,
    projectRuntimeByRepoId?: ReadonlyMap<string, ProjectExecutionRuntimeResolution>
  ): Promise<RuntimeWorktreeScanResult> {
    const { projectRuntime, runtimeKey, sshConnectionId } = ScanCache.resolveWorktreeScanRuntime(
      this.requireStore(),
      repo,
      projectRuntimeByRepoId
    )
    const now = Date.now()
    const scanScopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
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

  protected async workspaceUsesBareGitStorage(target: HostWorktreeTarget): Promise<boolean> {
    const parsed = splitWorktreeIdForFilesystem(target.id)
    if (!parsed || !this.store) {
      return false
    }
    const owners = this.store
      .getRepos()
      .filter((repo) => repo.id === parsed.repoId && getRepoExecutionHostId(repo) === target.hostId)
    const repo = owners.length === 1 ? owners[0] : undefined
    if (!repo || isFolderRepo(repo)) {
      return false
    }
    const key = `${repo.id}\0${target.hostId}`
    return workspaceRootIsBare(repo, parsed.worktreePath, {
      worktrees: ScanCache.readFreshWorktreeScan(
        this.requireStore(),
        repo,
        this.worktreeScanCache.get(key),
        this.worktreeScanGenerations.get(key) ?? 0
      ),
      ...(target.hostId === LOCAL_EXECUTION_HOST_ID
        ? getLocalProjectWorktreeGitOptions(this.requireStore(), repo)
        : {})
    })
  }

  listRepos(): Repo[] {
    return this.store?.getRepos() ?? []
  }
}
