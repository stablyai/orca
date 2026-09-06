import {
  isWorktreeCreatePreparation,
  parseWorktreePreparationOwnerPid,
  parseWorktreePreparationPathOwnerPid
} from '../shared/worktree/create-preparation'
import type { AddWorktreeOptions } from './git/worktree'
import { listWorktreeGraph } from './git/worktree'
import { discardPreparedWorktree, unlockPreparedWorktree } from './git/worktree-create-preparation'
import { retryPendingPreparationDiscards } from './worktree-preparation-discard-retry'

const STALE_PREPARATION_CLEANUP_CONCURRENCY = 4

const staleCleanupInFlight = new Map<string, Promise<void>>()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Reclaims preparations a crashed process left registered. Single-flighted per host key so a burst
 *  of arming calls shares one worktree listing. */
export async function cleanupStalePreparations(
  cleanupKey: string,
  repoPath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const existing = staleCleanupInFlight.get(cleanupKey)
  if (existing) {
    await existing.catch(() => {})
    return
  }
  const cleanup = (async () => {
    // Not awaited: the create path awaits this cleanup, and one stranded discard costs an unlock plus
    // a `worktree remove --force` bounded at 30s each. Reclaiming leaked scratch must not delay create.
    void retryPendingPreparationDiscards(cleanupKey)
    const worktrees = await listWorktreeGraph(repoPath, {
      ...options,
      includeCreatePreparations: true
    })
    const staleWorktrees = worktrees.filter(isWorktreeCreatePreparation)
    let nextIndex = 0
    async function discardNextStalePreparation(): Promise<void> {
      while (nextIndex < staleWorktrees.length) {
        const worktree = staleWorktrees[nextIndex]
        nextIndex += 1
        const lockOwnerPid = parseWorktreePreparationOwnerPid(worktree.lockReason)
        const pathOwnerPid = parseWorktreePreparationPathOwnerPid(worktree.path)
        if (!lockOwnerPid || isProcessAlive(lockOwnerPid)) {
          continue
        }
        // Preserve a branch-attached final path after a crash; only detached or
        // still-hidden preparations are safe to discard automatically.
        if (worktree.branch && pathOwnerPid === null) {
          await unlockPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        } else if (pathOwnerPid === lockOwnerPid) {
          await discardPreparedWorktree(repoPath, worktree.path, options).catch(() => {})
        }
      }
    }
    const workerCount = Math.min(STALE_PREPARATION_CLEANUP_CONCURRENCY, staleWorktrees.length)
    await Promise.all(Array.from({ length: workerCount }, () => discardNextStalePreparation()))
  })()
  staleCleanupInFlight.set(cleanupKey, cleanup)
  try {
    await cleanup.catch(() => {})
  } finally {
    if (staleCleanupInFlight.get(cleanupKey) === cleanup) {
      staleCleanupInFlight.delete(cleanupKey)
    }
  }
}

/** True while a crash-recovery scan is running, which means a create is in flight or imminent. */
export function hasPendingStalePreparationCleanup(): boolean {
  return staleCleanupInFlight.size > 0
}

export function resetStalePreparationCleanupForTests(): void {
  staleCleanupInFlight.clear()
}
