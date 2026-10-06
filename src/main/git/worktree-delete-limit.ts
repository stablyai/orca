/**
 * Deletes `git worktree remove` runs at once on this host.
 *
 * Why its own limit instead of general git admission: a large delete holds its child for 20-35 s,
 * and general admission can be as small as two slots, so two deletes there would stall every
 * status read. Two concurrent deletes already saturate one disk; more only slow each other.
 */
export const WORKTREE_DELETE_CONCURRENCY = 2

let running = 0
const waiting: (() => void)[] = []

export async function runUnderWorktreeDeleteLimit<T>(operation: () => Promise<T>): Promise<T> {
  if (running >= WORKTREE_DELETE_CONCURRENCY) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  } else {
    running += 1
  }
  try {
    return await operation()
  } finally {
    const next = waiting.shift()
    if (next) {
      // Why: hand the slot over directly so a new arrival cannot overtake a queued delete.
      next()
    } else {
      running -= 1
    }
  }
}

export function _worktreeDeleteLimitSnapshotForTests(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}
