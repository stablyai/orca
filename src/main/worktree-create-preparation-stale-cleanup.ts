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

const staleCleanupInFlight = new Map<string, { scanned: Promise<void>; settled: Promise<void> }>()

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** Returns after the shared host scan; file reclamation stays tracked in the background. */
export async function startStalePreparationCleanup(
  cleanupKey: string,
  repoPath: string,
  options: AddWorktreeOptions
): Promise<void> {
  const existing = staleCleanupInFlight.get(cleanupKey)
  if (existing) {
    await existing.scanned.catch(() => {})
    return
  }
  void retryPendingPreparationDiscards(cleanupKey)
  const scan = listWorktreeGraph(repoPath, {
    ...options,
    includeCreatePreparations: true
  })
  const scanned = scan.then(() => {})
  const cleanup = scan.then(async (worktrees) => {
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
  })
  // Keep reclamation single-flighted, but do not make a new checkout wait for old file removal.
  const entry = { scanned, settled: cleanup }
  staleCleanupInFlight.set(cleanupKey, entry)
  void cleanup
    .catch(() => {})
    .finally(() => {
      if (staleCleanupInFlight.get(cleanupKey) === entry) {
        staleCleanupInFlight.delete(cleanupKey)
      }
    })
  await scanned.catch(() => {})
}

/** Keeps repo maintenance paused through crash-recovery scanning and reclamation. */
export function hasPendingStalePreparationCleanup(): boolean {
  return staleCleanupInFlight.size > 0
}

export async function resetStalePreparationCleanupForTests(): Promise<void> {
  const cleanups = [...staleCleanupInFlight.values()].map((entry) => entry.settled)
  staleCleanupInFlight.clear()
  await Promise.allSettled(cleanups)
}
