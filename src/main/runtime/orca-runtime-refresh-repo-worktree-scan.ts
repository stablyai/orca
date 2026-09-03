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
  /**
   * Refresh one repo's worktree rows, skipping the `git worktree list` subprocess when a cheap
   * Git-admin fingerprint proves nothing changed since the cached scan.
   */
  protected async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    // SSH and WSL-routed repos run Git off-host, so a local admin-dir read cannot describe them.
    // Resolve the execution host rather than reading `connectionId`: a row stamped only
    // `executionHostId: 'ssh:*'` is just as off-host, and fingerprinting it stats client paths.
    const fingerprintCapable =
      !getRepoSshConnectionId(repo) &&
      // Why: a repo whose scan TTL already reaches the reconciliation interval can never reuse a
      // fingerprint, so reading one would be pure work. Agent-scratch roots are that case today.
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    // Why issue it before the scan: a change landing while the scan runs must not be stamped as
    // already-observed, or the next probe would mask it until the reconciliation deadline.
    const probe = fingerprintCapable ? this.startRepoWorktreeAdminFingerprintProbe(repo) : null
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    if (probe && reusable) {
      // Why await only here: this is the one branch whose decision needs the probe. A scan-bound
      // caller must never wait on it, or every cold read pays filesystem latency it cannot use.
      const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      if (!probed.ok) {
        // Why log: expiry and "fingerprint unavailable" both surface as `null`, so a wedged mount is
        // otherwise indistinguishable from a repo that simply cannot be fingerprinted.
        console.warn('[worktree-scan] admin fingerprint probe expired; running a full scan', {
          repoId: repo.id,
          timeoutMs: WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS
        })
      }
      const current = probed.ok ? probed.value : null
      if (current !== null && current === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: current,
          adminFingerprintProbe: null,
          scannedAt: reusable.scannedAt
        }
      }
    }
    const result = await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    return { result, adminFingerprint: null, adminFingerprintProbe: probe, scannedAt }
  }

  /**
   * Read one repo's Git-admin fingerprint, unless that repo's previous read is still outstanding.
   * Why the gate: `withTimeout` abandons a probe without cancelling it, and readdir/stat take no
   * AbortSignal — on a wedged mount a fresh probe per refresh would pin every libuv fs thread.
   */
  protected startRepoWorktreeAdminFingerprintProbe(repo: Repo): Promise<string | null> | null {
    if (this.worktreeAdminFingerprintProbes.has(repo.id)) {
      return null
    }
    this.worktreeAdminFingerprintProbes.add(repo.id)
    return readRepoWorktreeAdminFingerprint(repo.path)
      .catch(() => null)
      .finally(() => {
        this.worktreeAdminFingerprintProbes.delete(repo.id)
      })
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
