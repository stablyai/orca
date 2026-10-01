/**
 * Whether a user's local worktree create is in flight on this machine.
 *
 * Machine-wide rather than per repo: what a create competes with is the disk, and background git
 * or file deletion for any repo on the same machine slows its checkout just as much.
 *
 * Only background producers wait on this, and only at their entry, before they register shared
 * in-flight state — so a create can join work that is already running but never work parked
 * here. A request/response path a client awaits must never call `whenLocalWorktreeCreatesSettle`.
 */

export const LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS = 2 * 60_000

let activeCreates = 0
// Why per episode (from the first create until none is in flight): a per-waiter deadline would let
// every later batch or entry wait a fresh deadline behind the same stuck create.
let episodeDeadlineTimer: ReturnType<typeof setTimeout> | null = null
let episodeOutlastedDeadline = false
let settleWaiters: (() => void)[] = []

function wakeSettleWaiters(): void {
  const waiters = settleWaiters
  settleWaiters = []
  for (const wake of waiters) {
    wake()
  }
}

function endEpisode(): void {
  clearTimeout(episodeDeadlineTimer ?? undefined)
  episodeDeadlineTimer = null
  episodeOutlastedDeadline = false
  wakeSettleWaiters()
}

/** Returns an idempotent release; call it in `finally`. */
export function holdLocalWorktreeCreate(): () => void {
  activeCreates += 1
  if (activeCreates === 1) {
    episodeDeadlineTimer = setTimeout(() => {
      episodeDeadlineTimer = null
      episodeOutlastedDeadline = true
      wakeSettleWaiters()
    }, LOCAL_WORKTREE_CREATE_IDLE_DEADLINE_MS)
    episodeDeadlineTimer.unref?.()
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    activeCreates -= 1
    if (activeCreates === 0) {
      endEpisode()
    }
  }
}

export async function runWithLocalWorktreeCreateHold<T>(operation: () => Promise<T>): Promise<T> {
  const release = holdLocalWorktreeCreate()
  try {
    return await operation()
  } finally {
    release()
  }
}

/** Any local create running, past the deadline too: optional work (a spare) must not start then. */
export function isLocalWorktreeCreateInFlight(): boolean {
  return activeCreates > 0
}

/**
 * True while background producers should hold off: a create is in flight and this stretch of
 * creates has not yet outlasted the deadline, so a stuck create can never starve them for long.
 */
export function isBackgroundWorkHeldForLocalCreates(): boolean {
  return activeCreates > 0 && !episodeOutlastedDeadline
}

/**
 * Resolves once background work is no longer held: no create is in flight, or the current stretch
 * of creates outlasted the deadline. Background producer entry points only.
 */
export function whenLocalWorktreeCreatesSettle(): Promise<void> {
  if (!isBackgroundWorkHeldForLocalCreates()) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    settleWaiters.push(resolve)
  })
}

export type LocalWorktreeCreateDeferral = {
  /** True while the producer should hold off; starts the wait that calls `onSettle` once. */
  shouldDefer: () => boolean
}

/** For a producer that re-checks on every wake (a queue drain) instead of awaiting. */
export function createLocalWorktreeCreateDeferral(
  onSettle: () => void
): LocalWorktreeCreateDeferral {
  let waiting = false
  return {
    shouldDefer() {
      if (!isBackgroundWorkHeldForLocalCreates()) {
        return false
      }
      if (!waiting) {
        waiting = true
        void whenLocalWorktreeCreatesSettle().then(() => {
          waiting = false
          onSettle()
        })
      }
      return true
    }
  }
}

export function _resetLocalWorktreeCreateActivityForTests(): void {
  activeCreates = 0
  endEpisode()
}
