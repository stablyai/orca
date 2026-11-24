import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import {
  getRepoExecutionHostId,
  getRepoRoutingConnectionId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import {
  hostWorktreeTargetForRepo,
  readWorktreeMetaForHost
} from '../../../persistence/host-qualified-worktree-meta'
import {
  parseExactWorktreeIdSelector,
  type RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { getLocalWorktreeCatalogVersion } from '../../../workspaces/catalog/local-worktree-scan-generation'
import type { WorktreeCatalogVersion } from '../../../../shared/worktree/catalog/catalog-version'
import { WorktreeProviderError } from '../../../workspaces/providers/provider-process-runner'
import { readWorktreeProviderCatalog } from '../../../workspaces/providers/provider-config-reader'
import { acquireProviderWorktree } from '../../../workspaces/providers/provider-acquire'
import { releaseProviderWorktree } from '../../../workspaces/providers/provider-release'
import { readWorktreeProviderTrustFile } from '../../../workspaces/providers/provider-trust-store'
import { killAllProcessesForWorktree } from '../removal/worktree-teardown'
import {
  assertProviderRepoIsLocal,
  RuntimeWorktreeProviderConfig
} from './runtime-worktree-provider-config'

export abstract class RuntimeWorktreeProviders extends RuntimeWorktreeProviderConfig {
  async acquireManagedProviderWorktree(
    repoSelector: string,
    request: { provider: string; profile?: string }
  ) {
    const store = this.requireStore()
    const repo = await this.resolveRepoSelector(repoSelector)
    assertProviderRepoIsLocal(repo, store)
    const catalog = await readWorktreeProviderCatalog({
      repo,
      trust: await readWorktreeProviderTrustFile()
    })
    const result = await acquireProviderWorktree({
      repo,
      providerName: request.provider,
      ...(request.profile ? { profile: request.profile } : {}),
      catalog,
      ports: {
        getMeta: (worktreeId) =>
          readWorktreeMetaForHost(store, worktreeId, LOCAL_EXECUTION_HOST_ID) ??
          store.getWorktreeMeta(worktreeId),
        setMeta: (worktreeId, meta) =>
          store.setWorktreeMeta(hostWorktreeTargetForRepo(worktreeId, repo), meta),
        listWorktrees: (repoPath) => listWorktreesStrict(repoPath),
        hasWslDistro: (target) =>
          getLocalProjectWorktreeGitOptions(store, target).wslDistro !== undefined,
        invalidateScan: (repoId) => {
          this.invalidateResolvedWorktreeCache()
          this.invalidateWorktreeScanCacheForRepo(repoId)
        },
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId),
        showWorktree: (selector) => this.showManagedWorktree(selector)
      }
    })
    return {
      ...result,
      catalogVersion: getLocalWorktreeCatalogVersion(result.worktree.repoId)
    }
  }

  async releaseManagedProviderWorktree(
    selector: string,
    request: { hostId?: ExecutionHostId; force?: boolean; forget?: boolean }
  ): Promise<{
    released: true
    forgotten?: true
    provider: string
    warning?: string
    catalogVersion?: WorktreeCatalogVersion
  }> {
    const store = this.requireStore()
    if (request.hostId && request.hostId !== LOCAL_EXECUTION_HOST_ID) {
      throw new WorktreeProviderError(
        'worktree_provider_not_local',
        'Worktree providers run only on the Orca host that owns the repository checkout.',
        { hostId: request.hostId }
      )
    }
    const resolved = await this.resolveProviderReleaseTarget(selector, request.hostId)
    const repo = this.localProviderRepo(resolved.repoId)
    const trust = await readWorktreeProviderTrustFile()
    const catalog = await readWorktreeProviderCatalog({ repo, trust })
    const result = await releaseProviderWorktree({
      repo,
      worktreeId: resolved.target.id,
      worktreePath: resolved.target.path,
      meta: resolved.meta,
      catalog,
      force: request.force === true,
      forget: request.forget === true,
      ports: {
        teardown: async (worktreeId) => {
          try {
            const localProvider = this.getLocalProvider()
            await (localProvider
              ? killAllProcessesForWorktree(worktreeId, {
                  runtime: this,
                  resolvedWorktreeId: worktreeId,
                  localProvider,
                  closeStructuredSessions: true
                })
              : this.stopTerminalsForWorktree(`id:${worktreeId}`, {
                  resolvedWorktreeId: worktreeId
                }))
            return {}
          } catch (error) {
            return {
              warning: `The lease was released, but Orca could not stop every process in the workspace: ${
                error instanceof Error ? error.message : String(error)
              }`
            }
          }
        },
        purge: (worktreeId) =>
          this.removeWorktreeMetadataAndHistory(store, worktreeId, LOCAL_EXECUTION_HOST_ID),
        invalidateScan: (repoId) => {
          this.invalidateResolvedWorktreeCache()
          this.invalidateWorktreeScanCacheForRepo(repoId)
        },
        notifyChanged: (repoId) => this.notifyWorktreesChanged(repoId)
      }
    })
    return {
      ...result,
      catalogVersion: getLocalWorktreeCatalogVersion(repo.id)
    }
  }

  private async resolveProviderReleaseTarget(
    selector: string,
    hostId?: ExecutionHostId
  ): Promise<{
    repoId: string
    target: RuntimeWorktreeRemovalTarget
    meta: WorktreeMeta
  }> {
    const store = this.requireStore()
    const exact = parseExactWorktreeIdSelector(selector)
    if (exact) {
      const meta =
        readWorktreeMetaForHost(store, exact.id, LOCAL_EXECUTION_HOST_ID) ??
        store.getWorktreeMeta(exact.id)
      if (!meta?.worktreeProvider) {
        throw new WorktreeProviderError(
          'worktree_provider_not_managed',
          `Workspace ${exact.id} is not managed by a worktree provider.`,
          { worktreeId: exact.id }
        )
      }
      return { repoId: exact.repoId, target: exact, meta }
    }
    const worktree = await this.showManagedWorktree(selector, hostId)
    const meta =
      readWorktreeMetaForHost(store, worktree.id, LOCAL_EXECUTION_HOST_ID) ??
      store.getWorktreeMeta(worktree.id)
    if (!meta?.worktreeProvider) {
      throw new WorktreeProviderError(
        'worktree_provider_not_managed',
        `Workspace ${worktree.id} is not managed by a worktree provider.`,
        { worktreeId: worktree.id }
      )
    }
    return {
      repoId: worktree.repoId,
      target: { id: worktree.id, repoId: worktree.repoId, path: worktree.path },
      meta
    }
  }

  private localProviderRepo(repoId: string): Repo {
    const store = this.requireStore()
    const matches = store
      .getRepos()
      .filter(
        (repo) =>
          repo.id === repoId &&
          !getRepoRoutingConnectionId(repo) &&
          !isFolderRepo(repo) &&
          getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      )
    if (matches.length !== 1) {
      throw new WorktreeProviderError(
        'worktree_provider_not_local',
        matches.length === 0
          ? `No local Git repo owns workspace ${repoId}. Worktree providers run only on the host that owns the checkout.`
          : `Workspace ${repoId} is owned by ${matches.length} local repos and cannot be resolved unambiguously.`,
        { repoId }
      )
    }
    return matches[0]
  }
}
