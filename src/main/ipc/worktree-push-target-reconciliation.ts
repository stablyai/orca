// Why: `pr-*` remotes Orca adds for fork-PR review are only ever pruned by
// `worktree-push-target-cleanup.ts`, and only when a *single* worktree removal
// triggers it. Three things escape that: (1) legacy/reused metadata missing the
// `remoteCreated` flag, (2) a "preserve branch on delete" pinning its remote via
// `branch.*.remote` config long after the worktree is gone, and (3) a worktree
// removed outside Orca entirely (no removal event ever fires). This sweep
// inverts the same safety predicates over every `pr-*` remote in the repo
// instead of one removal, so all three eventually get reclaimed. It never adds
// new safety logic — see `worktree-push-target-cleanup.ts` for the predicates.

import { gitExecFileAsync } from '../git/runner'
import { listWorktrees } from '../git/worktree'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import type { GitPushTarget } from '../../shared/worktree/types'
import { WORKTREE_ID_SEPARATOR, worktreeIdComparisonKey } from '../../shared/worktree/id'
import { parseGitRemoteFetchUrls } from '../../shared/git-remote-url-index'
import {
  findWorktreeMetaReferencingRemote,
  hasBranchConfigUsingRemote,
  type GitRemoteExec,
  type WorktreePushTargetStore
} from './worktree-push-target-cleanup'

// Orca only ever mints `pr-head` or `pr-<owner>-<repo>` (see `sanitizeRemoteName`), optionally
// disambiguated with `-2`..`-99` (see `ensureUniqueRemoteName`). The naming convention alone is
// not proof of provenance -- a user could name a remote `pr-foo` -- so this only narrows which
// remotes are even considered; `hasOrcaCreatedProvenance` below is the actual safety gate.
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
  // Provenance gate: only touch a remote some worktree's persisted pushTarget explicitly
  // recorded Orca creating. Naming and URL shape are necessary but not sufficient proof.
  if (!referencingEntries.some(({ meta }) => meta.pushTarget?.remoteCreated === true)) {
    return false
  }
  const stillClaimedByLiveWorktree = referencingEntries.some(({ worktreeId }) => {
    const key = worktreeIdComparisonKey(worktreeId)
    return key !== null && liveWorktreeKeys.has(key)
  })
  if (stillClaimedByLiveWorktree) {
    return false
  }
  // A branch that still exists may push to this fork again later; only a branch that's
  // actually gone (force-deleted, or deleted outside the "preserve on delete" flow) frees it.
  if (
    await hasBranchConfigUsingRemote(execGit, repoPath, target, { requireExistingBranch: true })
  ) {
    return false
  }
  return true
}

// Exported for unit/real-git tests: the `execGit` seam and injected live-worktree paths let
// tests drive the sweep without a real repo (or with one, for the real-git coverage).
export async function reconcileOrphanedPrRemotesWithExec(
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore,
  execGit: GitRemoteExec,
  liveWorktreePaths: readonly string[]
): Promise<string[]> {
  const liveWorktreeKeys = new Set(
    liveWorktreePaths
      .map((path) => worktreeIdComparisonKey(`${repoId}${WORKTREE_ID_SEPARATOR}${path}`))
      .filter((key): key is string => key !== null)
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

// Why: the sweep costs a handful of git subprocesses (remote -v, worktree list, per-candidate
// config/for-each-ref); bound to once per repo per cooldown so bursts of removals don't repeat it.
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

/** SSH counterpart of {@link reconcileOrphanedPrRemotes}; the execution host owns the remotes. */
export async function reconcileOrphanedPrRemotesSsh(
  provider: SshGitProvider,
  repoPath: string,
  repoId: string,
  store: WorktreePushTargetStore
): Promise<void> {
  if (!shouldReconcileNow(repoId)) {
    return
  }
  lastReconciledAtByRepoId.set(repoId, Date.now())
  try {
    const liveWorktrees = await provider.listWorktrees(repoPath)
    logReclaimed(
      repoPath,
      await reconcileOrphanedPrRemotesWithExec(
        repoPath,
        repoId,
        store,
        (args, cwd) => provider.exec(args, cwd),
        liveWorktrees.map((worktree) => worktree.path)
      )
    )
  } catch (error) {
    console.warn(`[worktrees] Failed to reconcile orphaned PR remotes (SSH) for ${repoPath}`, error)
  }
}
