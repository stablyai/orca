import { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { Repo } from '../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { RuntimeWorktreeScanCache, RuntimeWorktreeScanRefresh } from '../orca-runtime-core'
import { resolveWorktreeScanCacheTtlMs } from '../runtime-worktree-scan-cache'
import {
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from '../orca-runtime-postlude'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../../project-runtime-git-options'
import { withTimeoutResult } from '../runtime-async-boundaries'
import { readRepoWorktreeAdminFingerprint } from '../repo-worktree-admin-fingerprint'
import type { RuntimeWorktreeScanResult } from '../repo-worktree-resolution-scan'
import { scanLocalRepoWorktreesForResolution } from '../repo-worktree-resolution-scan'
import { dropRepeatedWorktreeRows } from '../repeated-worktree-rows'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { listStoredWorktreeRowsForRepo } from '../repo-worktree-row-resolution'
import type { ResolvedWorktree } from '../runtime-worktree-path-identity'
import { getRepoExecutionHostId, getRepoSshConnectionId } from '../../../shared/execution-host'
import { blockedWslDistroForPath, wslDistroForPath } from '../../wsl/wsl-unc-access-gate'

const lastFingerprintUnknownWarnAt = new Map<string, number>()

// Why once per reconcile window: a wedged mount answers "unknown" on every poll.
function warnFingerprintUnknownOnce(repoId: string, reason: string): void {
  const now = Date.now()
  const last = lastFingerprintUnknownWarnAt.get(repoId)
  if (last !== undefined && now - last < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS) {
    return
  }
  lastFingerprintUnknownWarnAt.set(repoId, now)
  console.warn(
    '[worktree-scan] admin fingerprint unknown; reusing cached rows until the reconcile ceiling',
    {
      repoId,
      reason
    }
  )
}

export abstract class RuntimeWorkspaceRepoScanRefresh extends RuntimeWorkspaceCatalog {
  /** Reuse cached scans when a Git-admin fingerprint proves no change. */
  protected async refreshRepoWorktreeScan(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    cached: RuntimeWorktreeScanCache | null
  ): Promise<RuntimeWorktreeScanRefresh> {
    const scannedAt = Date.now()
    // E9: the admin reads below and the Git scan both boot a stopped distro; keep known rows until it runs.
    const wslDistro = getRepoSshConnectionId(repo)
      ? undefined
      : getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    if (
      !getRepoSshConnectionId(repo) &&
      wslDistroForPath(repo.path, wslDistro) &&
      (await blockedWslDistroForPath(repo.path, wslDistro))
    ) {
      return cached
        ? {
            result: cached.result,
            adminFingerprint: cached.adminFingerprint,
            adminFingerprintProbe: null,
            scannedAt: cached.scannedAt
          }
        : {
            result: { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) },
            adminFingerprint: null,
            adminFingerprintProbe: null,
            scannedAt
          }
    }
    // Fingerprint only on-host Git: executionHostId-only SSH and WSL paths cannot be described by local admin reads.
    const fingerprintCapable =
      !getRepoSshConnectionId(repo) &&
      // Skip fingerprints when scan TTL already reaches reconciliation; they could never be reused.
      resolveWorktreeScanCacheTtlMs(repo) < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS &&
      !getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime).wslDistro
    // Probe before scanning so concurrent changes cannot be stamped as already observed.
    const probe = fingerprintCapable ? this.startRepoWorktreeAdminFingerprintProbe(repo) : null
    const reusable =
      cached?.result.ok === true &&
      scannedAt - cached.scannedAt < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
        ? cached
        : null
    // Unknown probes reuse the cache without resetting scannedAt; rescanning on slow-mount timeouts amplifies load (#19312).
    const reuseCached = (): RuntimeWorktreeScanRefresh | null =>
      reusable
        ? {
            result: reusable.result,
            adminFingerprint: reusable.adminFingerprint,
            adminFingerprintProbe: null,
            scannedAt: reusable.scannedAt
          }
        : null
    if (probe === 'in-flight') {
      const reused = reuseCached()
      if (reused) {
        warnFingerprintUnknownOnce(repo.id, 'previous probe still pending')
        return reused
      }
    } else if (probe && reusable) {
      // Await only for a reusable cache; scan-bound callers cannot use the probe.
      const probed = await withTimeoutResult(probe, WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS)
      if (!probed.ok) {
        warnFingerprintUnknownOnce(repo.id, 'probe expired')
        return (
          reuseCached() ??
          (await this.scanRepoWorktreesForRefresh(repo, projectRuntime, null, scannedAt))
        )
      }
      // Only a known matching fingerprint proves no change.
      if (probed.value !== null && probed.value === reusable.adminFingerprint) {
        return {
          result: reusable.result,
          adminFingerprint: probed.value,
          adminFingerprintProbe: null,
          scannedAt: reusable.scannedAt
        }
      }
    }
    return await this.scanRepoWorktreesForRefresh(
      repo,
      projectRuntime,
      probe === 'in-flight' ? null : probe,
      scannedAt
    )
  }

  private async scanRepoWorktreesForRefresh(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    probe: Promise<string | null> | null,
    scannedAt: number
  ): Promise<RuntimeWorktreeScanRefresh> {
    const result = dropRepeatedWorktreeRows(
      await this.listRepoWorktreesForResolutionUncached(repo, projectRuntime)
    )
    return { result, adminFingerprint: null, adminFingerprintProbe: probe, scannedAt }
  }

  /** Allow one outstanding filesystem probe per repo: timeouts do not cancel readdir/stat, so repeated probes could exhaust libuv on wedged mounts. */
  protected startRepoWorktreeAdminFingerprintProbe(
    repo: Repo
  ): Promise<string | null> | 'in-flight' {
    if (this.worktreeAdminFingerprintProbes.has(repo.id)) {
      return 'in-flight'
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
    // Resolve executionHostId-only SSH rows too; client scans of remote paths would lose all worktrees.
    const sshConnectionId = getRepoSshConnectionId(repo)
    if (!sshConnectionId) {
      return await scanLocalRepoWorktreesForResolution(
        repo.path,
        getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
      )
    }
    // Why: this process serves no SSH git, so an SSH repo answers from its stored rows.
    return {
      ok: false,
      worktrees: this.listStoredWorktreesForResolution(repo)
    }
  }

  protected listStoredWorktreesForResolution(repo: Repo): GitWorktreeInfo[] {
    return this.store ? listStoredWorktreeRowsForRepo(this.requireStore(), repo) : []
  }

  protected async getResolvedWorktreeMap(): Promise<Map<string, ResolvedWorktree>> {
    return new Map((await this.listResolvedWorktrees()).map((worktree) => [worktree.id, worktree]))
  }

  invalidateResolvedWorktreeCache(): void {
    this.resolvedWorktrees.invalidateResolved()
  }

  invalidateWorktreeScanCacheForRepo(repoId: string): void {
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
