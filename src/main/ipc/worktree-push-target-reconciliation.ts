// Sweep all fork remotes with cleanup's shared predicates to reclaim leaks from legacy metadata or external worktree removal.

import { gitExecFileAsync } from '../git/runner'
import { listWorktrees } from '../git/worktree'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { WORKTREE_ID_SEPARATOR, worktreeIdentityKey } from '../../shared/worktree/id'
import { maintainForkRemotes } from '../git/fork-remote-refspec'
import {
  forkRemoteMetadata,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

const ORCA_PR_REMOTE_NAME_PATTERN =
  /^pr-(?:head|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:-[0-9]{1,2})?$/
export function isOrcaGeneratedPrRemoteName(name: string): boolean {
  return ORCA_PR_REMOTE_NAME_PATTERN.test(name)
}
export async function reconcileOrphanedPrRemotesWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec,
  readLiveWorktreePaths: () => Promise<readonly string[]>,
  scope = ''
): Promise<string[]> {
  return maintainForkRemotes(execGit, repoPath, {
    mode: 'remove',
    scope,
    existingBranchesOnly: true,
    read: async () => {
      const paths = await readLiveWorktreePaths()
      const live = new Set(
        paths.map((path) => worktreeIdentityKey(`${repoId}${WORKTREE_ID_SEPARATOR}${path}`))
      )
      const hosts = new Set(
        store
          .getRepos?.()
          .filter((repo) => repo.id === repoId)
          .map(getRepoExecutionHostId)
      )
      const owner = hosts.size === 1 ? [...hosts][0] : undefined
      const metadata = forkRemoteMetadata(store, repoId).map(({ worktreeId, meta }) => {
        if (
          live.has(worktreeIdentityKey(worktreeId)) ||
          meta.preserveBranchOnDelete ||
          (meta.hostId && meta.hostId !== owner)
        ) {
          return meta
        }
        const { pushTarget: _ignored, ...bases } = meta
        return bases
      })
      return { metadata, liveness: paths, select: isOrcaGeneratedPrRemoteName }
    }
  })
}

// Rate-limit subprocess-heavy sweeps so removal bursts cannot repeat the same repo scan.
const RECONCILE_COOLDOWN_MS = 60 * 60 * 1000
const lastReconciledAtByRepoId = new Map<string, number>()

function shouldReconcileNow(repoId: string): boolean {
  const last = lastReconciledAtByRepoId.get(repoId)
  return last === undefined || Date.now() - last >= RECONCILE_COOLDOWN_MS
}

export function _resetPrRemoteReconciliationRateLimitForTests(): void {
  lastReconciledAtByRepoId.clear()
}

function logReclaimed(repoPath: string, reclaimed: string[]): void {
  if (reclaimed.length > 0) {
    console.log(
      `[worktrees] Reclaimed ${reclaimed.length} orphaned PR remote(s) in ${repoPath}: ${reclaimed.join(', ')}`
    )
  }
}

/** Best-effort, rate-limited sweep run alongside single-target cleanup (see call sites). */
export async function reconcileOrphanedPrRemotes(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  gitOptions: { wslDistro?: string } = {}
): Promise<void> {
  if (!shouldReconcileNow(repoId)) {
    return
  }
  lastReconciledAtByRepoId.set(repoId, Date.now())
  try {
    logReclaimed(
      repoPath,
      await reconcileOrphanedPrRemotesWithExec(
        repoPath,
        repoId,
        store,
        (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
        async () => (await listWorktrees(repoPath, gitOptions)).map((worktree) => worktree.path),
        gitOptions.wslDistro
      )
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to reconcile orphaned PR remotes for ${repoPath}`, error)
  }
}
