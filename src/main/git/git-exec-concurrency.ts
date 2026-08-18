import { availableParallelism } from 'node:os'

// Bound how many buffered git/gh/glab subprocesses spawn at once. A per-worktree
// poll tick can fan out 60+ spawns in one burst (#7576), pinning CPU near 50%.
// Buffered reads are independent leaf operations (each awaits only its own
// child), so a counting semaphore smooths the burst with no deadlock risk.
// Streaming (gitSpawn) and sync spawns don't route through here, and the gh/glab
// retry sleeps sit between execFileCapture calls — outside the held slot.

// Why: high enough to keep a healthy poll fully parallel, low enough to clip the
// pathological burst; scaled to the host so small machines throttle sooner.
const DEFAULT_MAX_CONCURRENCY = Math.max(8, Math.min(24, availableParallelism()))

let maxConcurrency = DEFAULT_MAX_CONCURRENCY
let active = 0
const waiters: (() => void)[] = []

function acquire(): Promise<void> {
  if (active < maxConcurrency) {
    active += 1
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    waiters.push(() => {
      active += 1
      resolve()
    })
  })
}

function release(): void {
  active -= 1
  // Hand the freed slot straight to the next waiter (FIFO) so `active` never
  // dips and lets a late arrival jump the queue.
  const next = waiters.shift()
  if (next) {
    next()
  }
}

export async function withGitExecSlot<T>(run: () => Promise<T>): Promise<T> {
  await acquire()
  try {
    return await run()
  } finally {
    release()
  }
}

export function __getGitExecConcurrencyForTests(): {
  active: number
  queued: number
  max: number
} {
  return { active, queued: waiters.length, max: maxConcurrency }
}

export function __setGitExecMaxConcurrencyForTests(next: number): void {
  maxConcurrency = next
}

export function __resetGitExecConcurrencyForTests(): void {
  maxConcurrency = DEFAULT_MAX_CONCURRENCY
  active = 0
  waiters.length = 0
}
