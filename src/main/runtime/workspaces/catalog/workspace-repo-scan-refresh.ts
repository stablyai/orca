import { composeWorktreeId } from '../../../../shared/worktree/id'
import { RuntimeWorkspaceCatalog } from './workspace-catalog'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import {
  resolveWorktreeScanCacheTtlMs,
  resolveWorktreeScanRuntime
} from './runtime-worktree-scan-cache'
import {
  WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
  WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS
} from './worktree-scan-admin-budget'
import { getLocalProjectWorktreeGitOptionsForRuntime } from '../../../workspaces/execution-host/project-runtime-git-options'
import { readRepoWorktreeAdminFingerprint } from './repo-worktree-admin-fingerprint'
import type { RuntimeWorktreeScanAttempt } from './repo-worktree-resolution-scan'
import { scanLocalRepoWorktreesForResolution } from './repo-worktree-resolution-scan'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listStoredWorktreeRowsForRepo } from './repo-worktree-row-resolution'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import { getRepoSshConnectionId } from '../../../../shared/execution-host'
import {
  blockedWslDistroForPath,
  wslDistroForPath
} from '../../../wsl/filesystem/wsl-unc-access-gate'
import {
  invalidateWorktreeCatalogForRepo,
  peekWorktreeCatalog,
  readWorktreeCatalog
} from '../../../workspaces/catalog/repo-worktree-catalog-owner'
import { runtimeResultForObservation } from './runtime-worktree-catalog-read'
import {
  needsWorktreeCatalogHygieneClaim,
  worktreeCatalogHygienePlan
} from '../../../ipc/worktrees/listing/worktree-catalog-observation-hygiene'
import type { Store } from '../../../persistence/loading-store/store'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import {
  captureGitWorktreeObservationCommit,
  gitWorktreeObservationReader
} from '../../../workspaces/catalog/git-worktree-observations'
import { readAllWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'

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
  private captureStoreObservationAuthority(store: RuntimeStore, isCurrent: () => boolean) {
    return () => this.store === store && isCurrent()
  }

  /** Runtime readers accept the owner's observation for the scan TTL, then its admin-fingerprint verifier. */
  protected async readRepoWorktreeCatalog(
    repo: Repo,
    projectRuntime: ProjectExecutionRuntimeResolution | undefined,
    runtimeKey: string,
    claimsHygiene: boolean
  ): Promise<RuntimeWorktreeScanAttempt> {
    const gitOptions = getLocalProjectWorktreeGitOptionsForRuntime(repo, projectRuntime)
    // E9: the admin reads below and the Git scan both boot a stopped distro; keep known rows until it runs.
    if (
      wslDistroForPath(repo.path, gitOptions.wslDistro) &&
      (await blockedWslDistroForPath(repo.path, gitOptions.wslDistro))
    ) {
      // Known rows only while nothing has invalidated them; otherwise last stored rows, as non-authoritative.
      const known = peekWorktreeCatalog(repo, runtimeKey)
      return known?.current
        ? runtimeResultForObservation(known.observation)
        : { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    // Admission and the owner route must agree: a route replaced while the distro check ran is not read.
    const live = this.store
      ? resolveWorktreeScanRuntime(this.requireStore(), repo)
      : { runtimeKey, projectRuntime }
    if (
      live.runtimeKey !== runtimeKey ||
      getLocalProjectWorktreeGitOptionsForRuntime(repo, live.projectRuntime).wslDistro !==
        gitOptions.wslDistro
    ) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    const ttlMs = resolveWorktreeScanCacheTtlMs(repo)
    // WSL execution cannot be described by local admin reads; a TTL at the ceiling could never reuse a probe.
    const verifier =
      ttlMs < WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS && !gitOptions.wslDistro
        ? {
            ceilingMs: WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS,
            timeoutMs: WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS,
            probe: () => this.startRepoWorktreeAdminFingerprintProbe(repo),
            onUnknown: (reason: string) => warnFingerprintUnknownOnce(repo.id, reason)
          }
        : undefined
    const store = this.store
    const hygiene = store
      ? worktreeCatalogHygienePlan(store as unknown as Store, repo, gitOptions, claimsHygiene)
      : undefined
    const { observation, superseded } = await readWorktreeCatalog(
      repo,
      runtimeKey,
      {
        kind: 'runtime',
        maxAgeMs: ttlMs,
        reusesFailure: true,
        // Listing and structured callers own their retry bounds around this single attempt.
        overtakenFlights: 1,
        ...(verifier ? { verifier } : {}),
        ...(claimsHygiene ? { needsHygieneClaim: needsWorktreeCatalogHygieneClaim(repo) } : {})
      },
      {
        scan: async () => {
          const scan = await withRepositoryGitCause(
            repo.path,
            gitOptions,
            { family: 'catalog', reason: 'runtime-catalog', cache: 'refresh' },
            () => scanLocalRepoWorktreesForResolution(repo.path, gitOptions)
          )
          if (scan.ok) {
            return { kind: 'rows', worktrees: scan.worktrees }
          }
          return scan.trueEmpty
            ? { kind: 'true-empty' }
            : { kind: 'failed', error: new Error(`worktree list failed for ${repo.path}`) }
        },
        ...(store
          ? {
              captureObservation: () => {
                const commit = captureGitWorktreeObservationCommit(store, repo)
                return {
                  ...commit,
                  isCurrent: this.captureStoreObservationAuthority(store, commit.isCurrent)
                }
              }
            }
          : {}),
        ...hygiene
      }
    )
    if (!observation) {
      return { ok: false, worktrees: this.listStoredWorktreesForResolution(repo) }
    }
    const result = runtimeResultForObservation(observation)
    const isCurrent = result.isCurrent ?? (() => false)
    if (superseded || (result.ok && !isCurrent())) {
      return { ok: false, worktrees: [], superseded: true }
    }
    if (result.ok) {
      return isCurrent() ? result : { ok: false, worktrees: [], superseded: true }
    }
    const meta = store ? readAllWorktreeMetaForRepo(store, repo) : {}
    const readObservation = gitWorktreeObservationReader(this.requireStore(), repo)
    return {
      ok: false,
      worktrees: this.listStoredWorktreesForResolution(repo).filter((git) =>
        readObservation(meta[composeWorktreeId(repo.id, git.path)])
      )
    }
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
    invalidateWorktreeCatalogForRepo(repoId)
    this.pruneUnregisteredWorktreeScans()
  }

  invalidateWorktreeCatalog(repoId: string): void {
    this.invalidateResolvedWorktreeCache()
    this.invalidateWorktreeScanCacheForRepo(repoId)
  }

  protected invalidateSshWorktreeScanCacheInternal(targetId: string): void {
    // SSH repos answer from stored rows and own no Git observation here; only projections go stale.
    const repos = this.store?.getRepos() ?? []
    if (repos.some((repo) => getRepoSshConnectionId(repo) === targetId)) {
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
import { withRepositoryGitCause } from '../../../git/repository-git-cause'
