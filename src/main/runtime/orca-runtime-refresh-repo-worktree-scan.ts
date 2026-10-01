// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithListKnownResolvedWorktreesForExplicitTarget } from './orca-runtime-list-known-resolved-worktrees-for-explicit-target'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeScanRefresh } from './orca-runtime-core'
import { markWorktreeMembershipDirty } from '../git/worktree-membership/worktree-membership-store'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../project-runtime-git-options'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listStoredWorktreeRowsForRepo } from './repo-worktree-row-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../shared/execution-host'

export class OrcaRuntimeWithRefreshRepoWorktreeScan extends OrcaRuntimeWithListKnownResolvedWorktreesForExplicitTarget {
  /** One repo's worktree rows. Local repos read their membership model, which decides freshness. */
  protected async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined
  ): Promise<RuntimeWorktreeScanRefresh> {
    return { result: await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime) }
  }

  protected async listRepoWorktreesForResolutionUncached(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined
  ): Promise<RuntimeWorktreeScanResult> {
    // Why not `repo.connectionId`: SSH ownership has two spellings, and a repo carrying only
    // `executionHostId: 'ssh:*'` would otherwise be scanned on the client against a remote path —
    // `git worktree list` then reports nothing, so the remote worktrees never resolve at all.
    const sshConnectionId = getRepoSshConnectionId(repo)
    if (!sshConnectionId) {
      return await scanLocalRepoWorktreesForResolution(
        repo.path,
        getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
      )
    }
    const provider = getSshGitProvider(sshConnectionId)
    if (!provider) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    try {
      return { ok: true, worktrees: await provider.listWorktrees(repo.path) }
    } catch {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
  }

  protected listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[] {
    return this.store ? listStoredWorktreeRowsForRepo(this.requireStore(), repo) : []
  }

  protected async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  protected invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktrees.invalidateResolved()
  }

  protected invalidateWorktreeScanCacheForRepo(repoId: string): void {
    const prefix = `${repoId}\0`
    const scopeKeys = new Set(
      this.store
        ?.getRepos()
        .filter((repo) => repo.id === repoId)
        .map((repo) => `${repoId}\0${getRepoExecutionHostId(repo)}`) ?? []
    )
    for (const keys of [
      this.worktreeScanGenerations.keys(),
      this.worktreeScanCache.keys(),
      this.worktreeScanInFlight.keys()
    ]) {
      for (const key of keys) {
        if (key.startsWith(prefix)) {
          scopeKeys.add(key)
        }
      }
    }
    for (const key of scopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
    // Every invalidate-then-read caller must get a derivation that starts after this call.
    for (const repo of this.store?.getRepos() ?? []) {
      if (repo.id === repoId && !getRepoSshConnectionId(repo)) {
        markWorktreeMembershipDirty(repo.path)
      }
    }
  }

  invalidateWorktreeCatalog(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
  }

  protected invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    const repos = this.store?.getRepos() ?? []
    const affectedRepos = repos.filter((repo) => getRepoSshConnectionId(repo) === targetId)
    const affectedScopeKeys = new Set(
      affectedRepos.map((repo) => `${repo.id}\0${getRepoExecutionHostId(repo)}`)
    )
    for (const key of affectedScopeKeys) {
      this.worktreeScanGenerations.set(key, (this.worktreeScanGenerations.get(key) ?? 0) + 1)
      this.worktreeScanCache.delete(key)
      this.worktreeScanInFlight.delete(key)
    }
    if (affectedScopeKeys.size > 0) {
      this.resolvedWorktrees.invalidateResolved()
    }
  }

  /** Invalidate the worktree cache and tell the renderer to re-list after an out-of-band branch change so the new name surfaces immediately. */
  notifyBranchRenamed(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifyWorktreesChanged(repoId)
  }

  /** Like {@link notifyBranchRenamed} but carries old->new worktree id so the renderer re-keys instead of treating the id change as a deletion. */
  notifyWorktreeFolderRenamed(repoId: string, oldWorktreeId: string, newWorktreeId: string): void {
    this.clientSessionTabSelections.migrateWorktree(oldWorktreeId, newWorktreeId)
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
    this.notifier?.worktreesChanged(repoId, { oldWorktreeId, newWorktreeId })
    // Mirror notifyBranchRenamed so in-process onClientEvent listeners also see the rename.
    this.emitClientEvent({ type: 'worktreesChanged', repoId })
  }

  notifyFolderWorkspaceChanged(): void {
    this.invalidateResolvedWorktreeCache()
    this.notifyReposChanged()
  }
}
