import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { isUnobservedWorktreeIdentity } from '../../../../shared/worktree/hosted-review-branch-ownership'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { readRebaseOperation } from '../../source-control/git-conflict-operation'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'

const DETACHED_REBASE_READ_CONCURRENCY = 8

async function detachedRebaseVerdict(
  worktree: GitWorktreeInfo,
  options: GitWorktreeExecOptions
): Promise<GitWorktreeInfo['detachedRebase']> {
  const read = await readRebaseOperation(worktree.path, options)
  if (read.state === 'active') {
    return read.branch ? { active: true, branch: read.branch } : { active: true }
  }
  // HEAD reattached since the listing read it: that detached row is stale, not proven.
  return read.state === 'none' && read.headDetached ? { active: false } : undefined
}

/** Detached rows get their owning host's rebase verdict; unverifiable reads stay unannotated. */
export async function annotateDetachedRebaseOperations(
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const detached = worktrees.filter(
    (worktree) =>
      !worktree.isBare && worktree.branch === '' && !isUnobservedWorktreeIdentity(worktree)
  )
  if (detached.length === 0) {
    return worktrees
  }
  const verdicts = new Map<GitWorktreeInfo, GitWorktreeInfo['detachedRebase']>()
  // Why the signal: a hung mount must not hold the listing past its caller's abort.
  await waitForPromiseWithSignal(
    mapWithConcurrency(detached, DETACHED_REBASE_READ_CONCURRENCY, async (worktree) => {
      verdicts.set(worktree, await detachedRebaseVerdict(worktree, options))
    }),
    options.signal
  )
  throwIfSignalAborted(options.signal)
  return worktrees.map((worktree) => {
    const detachedRebase = verdicts.get(worktree)
    return detachedRebase ? { ...worktree, detachedRebase } : worktree
  })
}
