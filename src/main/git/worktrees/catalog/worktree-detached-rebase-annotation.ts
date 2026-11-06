import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/abort-signal-reason'
import { BoundedMap } from '../../../../shared/bounded-map'
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

// Filesystem reads cannot be cancelled; overlapping scans skip a checkout until its read settles.
const pendingProbeKeys = new Set<string>()
// Keep only the next path, never a verdict: every observation still reads fresh metadata.
const nextProbePaths = new BoundedMap<string, string>({ maxEntries: 256 })

async function detachedRebaseVerdict(
  worktree: GitWorktreeInfo,
  options: GitWorktreeExecOptions,
  remainingMs: number,
  key: string
): Promise<GitWorktreeInfo['detachedRebase']> {
  pendingProbeKeys.add(key)
  const probe = readRebaseOperation(worktree.path, options).finally(() => {
    pendingProbeKeys.delete(key)
  })
  const read = await withTimeout(probe, remainingMs, UNVERIFIED)
  if (read.state === 'active') {
    return read.branch ? { active: true, branch: read.branch } : { active: true }
  }
  // HEAD reattached since the listing read it: that detached row is stale, not proven.
  return read.state === 'none' && read.headDetached ? { active: false } : undefined
}

/** Detached rows get their owning host's rebase verdict within a budget; others stay unknown. */
export async function annotateDetachedRebaseOperations(
  repoPath: string,
  worktrees: GitWorktreeInfo[],
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo[]> {
  const detached = worktrees.filter(
    (worktree) =>
      !worktree.isBare && worktree.branch === '' && !isUnobservedWorktreeIdentity(worktree)
  )
  const scanKey = `${options.wslDistro ?? ''}\0${repoPath}`
  if (detached.length === 0) {
    nextProbePaths.delete(scanKey)
    return worktrees
  }
  const nextPath = nextProbePaths.get(scanKey)
  const startIndex = Math.max(
    0,
    detached.findIndex((worktree) => worktree.path === nextPath)
  )
  const ordered = [...detached.slice(startIndex), ...detached.slice(0, startIndex)]
  const deadlineAt = Date.now() + DETACHED_REBASE_READ_BUDGET_MS
  const verdicts = new Map<GitWorktreeInfo, GitWorktreeInfo['detachedRebase']>()
  await waitForPromiseWithSignal(
    mapWithConcurrency(ordered, DETACHED_REBASE_READ_CONCURRENCY, async (worktree, index) => {
      const remainingMs = deadlineAt - Date.now()
      const key = `${options.wslDistro ?? ''}\0${worktree.path}`
      if (remainingMs <= 0 || options.signal?.aborted || pendingProbeKeys.has(key)) {
        return
      }
      // Advance at admission, so a budget expiry or cancellation cannot restart the same prefix.
      nextProbePaths.set(scanKey, ordered[(index + 1) % ordered.length].path)
      verdicts.set(worktree, await detachedRebaseVerdict(worktree, options, remainingMs, key))
    }),
    options.signal
  )
  throwIfSignalAborted(options.signal)
  return worktrees.map((worktree) => {
    const detachedRebase = verdicts.get(worktree)
    return detachedRebase ? { ...worktree, detachedRebase } : worktree
  })
}
