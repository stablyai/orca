// Use a separate two-delete queue: long disk-bound removals must not occupy general Git read slots.
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
      // Hand off directly so new arrivals cannot overtake queued deletes.
      next()
    } else {
      running -= 1
    }
  }
}

export function _worktreeDeleteLimitSnapshotForTests(): { running: number; waiting: number } {
  return { running, waiting: waiting.length }
}
