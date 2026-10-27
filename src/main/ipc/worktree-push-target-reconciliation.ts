// Sweep all fork remotes with cleanup's shared predicates to reclaim leaks from legacy metadata or external worktree removal.

import { gitExecFileAsync } from '../git/runner'
import { listWorktrees } from '../git/worktree'
import type { GitPushTarget } from '../../shared/worktree/types'
import { WORKTREE_ID_SEPARATOR, worktreeIdentityKey } from '../../shared/worktree/id'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import {
  findWorktreeMetaReferencingRemote,
  hasBranchConfigUsingRemote,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

// Orca-shaped names only narrow candidates; provenance must independently prove ownership.
const ORCA_PR_REMOTE_NAME_PATTERN =
  /^pr-(?:head|[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?)(?:-[0-9]{1,2})?$/

export function isOrcaGeneratedPrRemoteName(name: string): boolean {
  return ORCA_PR_REMOTE_NAME_PATTERN.test(name)
}

type PrRemoteCandidate = { name: string; url: string }

async function listPrRemoteCandidates(
  execGit: GitRemoteExec,
  repoPath: string
): Promise<PrRemoteCandidate[]> {
  let stdout: string
  try {
    ;({ stdout } = await execGit(['remote', '-v'], repoPath))
  } catch {
    return []
  }
  return [...parseGitRemoteFetchUrls(stdout)]
    .filter(([name]) => isOrcaGeneratedPrRemoteName(name))
    .map(([name, url]) => ({ name, url }))
}

async function shouldReclaimPrRemote(
  execGit: GitRemoteExec,
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  remote: PrRemoteCandidate,
  liveWorktreeKeys: ReadonlySet<string>
): Promise<boolean> {
  const target: Pick<GitPushTarget, 'remoteName' | 'remoteUrl'> = {
    remoteName: remote.name,
    remoteUrl: remote.url
  }
  const referencingEntries = findWorktreeMetaReferencingRemote(store, repoId, target)
  // Require persisted creation provenance; names and URLs cannot prove ownership.
  if (!referencingEntries.some(({ meta }) => meta.pushTarget?.remoteCreated === true)) {
    return false
  }
  const stillClaimedByLiveWorktree = referencingEntries.some(({ worktreeId }) =>
    liveWorktreeKeys.has(worktreeIdentityKey(worktreeId))
  )
  if (stillClaimedByLiveWorktree) {
    return false
  }
  // Preserved branches still need their fork even after the worktree is gone.
  if (
    await hasBranchConfigUsingRemote(execGit, repoPath, target, { requireExistingBranch: true })
  ) {
    return false
  }
  return true
}

export async function reconcileOrphanedPrRemotesWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec,
  liveWorktreePaths: readonly string[]
): Promise<string[]> {
  const liveWorktreeKeys = new Set(
    liveWorktreePaths.map((path) => worktreeIdentityKey(`${repoId}${WORKTREE_ID_SEPARATOR}${path}`))
  )
  const reclaimed: string[] = []
  for (const remote of await listPrRemoteCandidates(execGit, repoPath)) {
    if (await shouldReclaimPrRemote(execGit, repoPath, repoId, store, remote, liveWorktreeKeys)) {
      await execGit(['remote', 'remove', remote.name], repoPath)
      reclaimed.push(remote.name)
    }
  }
  return reclaimed
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
    const liveWorktrees = await listWorktrees(repoPath, gitOptions)
    logReclaimed(
      repoPath,
      await reconcileOrphanedPrRemotesWithExec(
        repoPath,
        repoId,
        store,
        (args, cwd) => gitExecFileAsync(args, { cwd, ...gitOptions }),
        liveWorktrees.map((worktree) => worktree.path)
      )
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to reconcile orphaned PR remotes for ${repoPath}`, error)
  }
}
