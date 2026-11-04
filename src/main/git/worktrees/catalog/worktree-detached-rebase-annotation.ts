import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { withTimeout } from '../../../../shared/promise-timeout-fallback'
import { isUnobservedWorktreeIdentity } from '../../../../shared/worktree/hosted-review-branch-ownership'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  readRebaseOperation,
  type RebaseOperationRead
} from '../../source-control/git-conflict-operation'
import type { GitWorktreeExecOptions } from '../worktree-operation-options'

const DETACHED_REBASE_READ_CONCURRENCY = 8
/** The whole annotation's budget; rows it cannot read in time stay unannotated (unknown). */
const DETACHED_REBASE_READ_BUDGET_MS = 2_000
const UNVERIFIED: RebaseOperationRead = { state: 'unverifiable' }

// Why: a read on a hung mount cannot be cancelled. A checkout whose read outlived its budget gets
// no new one until that read settles, so repeated scans cannot pile reads onto it. Holds no results.
const stuckProbeKeys = new Set<string>()

async function detachedRebaseVerdict(
  worktree: GitWorktreeInfo,
  options: GitWorktreeExecOptions,
  deadlineAt: number
): Promise<GitWorktreeInfo['detachedRebase']> {
  const key = `${options.wslDistro ?? ''}\0${worktree.path}`
  const remainingMs = deadlineAt - Date.now()
  if (remainingMs <= 0 || options.signal?.aborted || stuckProbeKeys.has(key)) {
    return undefined
  }
  let settled = false
  const probe = readRebaseOperation(worktree.path, options).finally(() => {
    settled = true
    stuckProbeKeys.delete(key)
  })
  const read = await withTimeout(probe, remainingMs, UNVERIFIED)
  if (!settled) {
    stuckProbeKeys.add(key)
  }
  if (read.state === 'active') {
    return read.branch ? { active: true, branch: read.branch } : { active: true }
  }
  // HEAD reattached since the listing read it: that detached row is stale, not proven.
  return read.state === 'none' && read.headDetached ? { active: false } : undefined
}

/** Detached rows get their owning host's rebase verdict within a budget; others stay unknown. */
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
  const deadlineAt = Date.now() + DETACHED_REBASE_READ_BUDGET_MS
  const verdicts = new Map<GitWorktreeInfo, GitWorktreeInfo['detachedRebase']>()
  await waitForPromiseWithSignal(
    mapWithConcurrency(detached, DETACHED_REBASE_READ_CONCURRENCY, async (worktree) => {
      verdicts.set(worktree, await detachedRebaseVerdict(worktree, options, deadlineAt))
    }),
    options.signal
  )
  throwIfSignalAborted(options.signal)
  return worktrees.map((worktree) => {
    const detachedRebase = verdicts.get(worktree)
    return detachedRebase ? { ...worktree, detachedRebase } : worktree
  })
}
