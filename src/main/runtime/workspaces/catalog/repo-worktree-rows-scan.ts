import { preserveFolderUpgradeWorktreePath } from '../../../workspaces/catalog/folder-upgrade-worktree-path'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { readAllWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/execution-host/project-execution-runtime'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { pendingWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-table'
import type {
  RuntimeWorktreeScanResult,
  RepoWorktreeRowsScan
} from './repo-worktree-resolution-scan'
import type { RepoWorktreeRowDeps } from './repo-worktree-row-resolution'

/** Bound each repo independently for mobile startup; fingerprint probes derive their smaller budget from this shared constant. */
export const RESOLVED_WORKTREE_REPO_TIMEOUT_MS = 5000

/** Publish last-known persisted rows on unreachable/stalled scans, matching disconnected SSH listing behavior. */
export function listStoredWorktreeRowsForRepo(
  store: RepoWorktreeRowDeps['store'],
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): GitWorktreeInfo[] {
  const expectedHostId = getRepoExecutionHostId(repo)
  const byWorktreeId = new Map<string, GitWorktreeInfo>()
  for (const [worktreeId, meta] of Object.entries(
    readAllWorktreeMetaForHost(store, expectedHostId)
  )) {
    const parsed = splitWorktreeId(worktreeId)
    // An archived row has no checkout, so it must not come back as a live worktree.
    if (!parsed || parsed.repoId !== repo.id || meta.archivedCheckout) {
      continue
    }
    // Same repo ids can belong to several hosts; degraded scans must not publish another owner's metadata.
    if (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1) {
      continue
    }
    byWorktreeId.set(worktreeId, {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: areWorktreePathsEqual(parsed.worktreePath, repo.path),
      ...(meta.sparseDirectories !== undefined ||
      meta.sparseBaseRef !== undefined ||
      meta.sparsePresetId !== undefined
        ? { isSparse: true }
        : {})
    })
  }
  return [...byWorktreeId.values()]
}

/** The scan half of `resolveRepoWorktreeRows`: slow, and the only part that awaits. */
export async function readRepoWorktreeRowsScan(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'scanRepo' | 'getCachedSuccessfulScan'>,
  repo: Repo,
  projectRuntimeByRepoId: ReadonlyMap<string, ProjectExecutionRuntimeResolution>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): Promise<RepoWorktreeRowsScan> {
  const { store } = deps
  const removals =
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
      ? pendingWorktreeRemovals.snapshotForRepo(repo.id)
      : undefined
  // Absorb rejection before withTimeout: rejection preserves shipped empty results, but timeout restores last-known rows.
  const scan: RuntimeWorktreeScanResult = (await withTimeout<RuntimeWorktreeScanResult | null>(
    deps
      .scanRepo(repo, projectRuntimeByRepoId)
      .catch(() => ({ ok: false, worktrees: [] }) satisfies RuntimeWorktreeScanResult),
    RESOLVED_WORKTREE_REPO_TIMEOUT_MS,
    null
  )) ?? {
    ok: false,
    worktrees:
      deps.getCachedSuccessfulScan?.(repo)?.worktrees ??
      listStoredWorktreeRowsForRepo(store, repo, repoOwnerCount)
  }
  const gitWorktrees = preserveFolderUpgradeWorktreePath(repo, scan.worktrees)
  return {
    ok: scan.ok,
    worktrees: gitWorktrees,
    observation: scan,
    removals,
    projectedRemovals: removals
  }
}
