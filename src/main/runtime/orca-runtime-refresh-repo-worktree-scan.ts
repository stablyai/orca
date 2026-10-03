// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithListKnownResolvedWorktreesForExplicitTarget } from './orca-runtime-list-known-resolved-worktrees-for-explicit-target'
import type { Repo } from '../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanRefresh } from './orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from './runtime-worktree-scan-cache'
import {
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from './orca-runtime-postlude'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../project-runtime-git-options'
import { withTimeoutResult } from './runtime-async-boundaries'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'
import type { RuntimeWorktreeScanResult } from './repo-worktree-resolution-scan'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { listStoredWorktreeRowsForRepo } from './repo-worktree-row-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../shared/execution-host'

export class OrcaRuntimeWithRefreshRepoWorktreeScan extends OrcaRuntimeWithListKnownResolvedWorktreesForExplicitTarget {
  protected async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    const scopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scopeKey) ?? 0
    const fingerprintCapable =
      !getRepoSshConnectionId(repo) &&
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    let fingerprint: string | null = null
    if (fingerprintCapable) {
      const probe = this.startRepoWorktreeAdminFingerprintProbe(repo)
      if (probe) {
        const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
        if (probed.ok) {
          fingerprint = probed.value
        } else {
          const pending = this.worktreeAdminFingerprintProbes.get(repo.id)
          if (pending?.promise === probe) {
            pending.expired = true
          }
          console.warn('[worktree-scan] admin fingerprint probe expired', {
            repoId: repo.id,
            timeoutMs: WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
          })
        }
      }
      if (generation !== (this.worktreeScanGenerations.get(scopeKey) ?? 0)) {
        return this.unavailableRepoWorktreeScanRefresh(repo, cached, scannedAt)
      }
      if (reusable && fingerprint === null) {
        return this.unavailableRepoWorktreeScanRefresh(repo, reusable, scannedAt)
      }
      if (reusable && fingerprint === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: fingerprint,
          scannedAt: reusable.scannedAt
        }
      }
    }
    const result = await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    return { result, adminFingerprint: fingerprint, scannedAt }
  }

  protected startRepoWorktreeAdminFingerprintProbe(repo: Repo): Promise<string | null> | null {
    const scopeKey = `${repo.id}\0${getRepoExecutionHostId(repo)}`
    const generation = this.worktreeScanGenerations.get(scopeKey) ?? 0
    const existing = this.worktreeAdminFingerprintProbes.get(repo.id)
    if (existing) {
      return existing.scopeKey === scopeKey &&
        existing.path === repo.path &&
        existing.generation === generation
        ? existing.promise
        : null
    }
    const pending = readRepoWorktreeAdminFingerprint(repo.path).catch(() => null)
    const entry = { scopeKey, path: repo.path, generation, promise: pending, expired: false }
    entry.promise = pending
      .then((fingerprint) => (entry.expired ? null : fingerprint))
      .finally(() => {
        if (this.worktreeAdminFingerprintProbes.get(repo.id) === entry) {
          this.worktreeAdminFingerprintProbes.delete(repo.id)
        }
      })
    this.worktreeAdminFingerprintProbes.set(repo.id, entry)
    return entry.promise
  }

  protected unavailableRepoWorktreeScanRefresh(
    repo: Repo,
    cached: RuntimeWorktreeScanCache | null,
    scannedAt: number
  ): RuntimeWorktreeScanRefresh {
    return {
      result: { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) },
      adminFingerprint: cached?.adminFingerprint ?? null,
      scannedAt: cached?.scannedAt ?? scannedAt,
      fingerprintUnavailable: true
    }
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
