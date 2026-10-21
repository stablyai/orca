import type { PreparedCheckoutOrigin } from '../shared/worktree/create-types'
import { beginPreparationWork, type PreparationWork } from './worktree-create-concurrency'

/** What a create's event reports about the prepared checkout it used: who asked for it, and the
 *  disk work of its build and tip refreshes, and their timing. Recording only; never gates the pool. */
export type PreparationActivity = {
  /** Counts the latest build or refresh as disk work competing with creates. */
  readonly work: PreparationWork
  /** An explicit prefetch asked for this checkout too. */
  requestedByPrefetch(): void
  /** Covers `ready`, the checkout's latest build or tip refresh, until it settles. */
  track(ready: Promise<void>): void
  origin(): PreparedCheckoutOrigin
  /** First build's duration, and how long the checkout sat ready before `claimedAt`. */
  timesAt(claimedAt: number): { buildMs: number; idleMs: number }
}

export function createPreparationActivity(kind: 'explicit' | 'automatic'): PreparationActivity {
  let work = beginPreparationWork()
  let workSettled = false
  // Build: from the first build's start (including any wait for the base fetch it is built on)
  // to its first ready; a later tip refresh does not restart it.
  const buildStartedAt = performance.now()
  let buildFinishedAt: number | undefined
  // Idle: measured from the latest ready, build or refresh, to the claim.
  let latestReadyAt: number | undefined
  let latest: Promise<void> | undefined
  let prefetchRequested = false

  return {
    get work() {
      return work
    },
    requestedByPrefetch() {
      prefetchRequested = true
    },
    track(ready) {
      // A refresh queued after the previous work settled is new disk work.
      if (workSettled) {
        work = beginPreparationWork()
        workSettled = false
      }
      latest = ready
      latestReadyAt = undefined
      const current = work
      const settle = (succeeded: boolean): void => {
        const now = performance.now()
        if (succeeded) {
          buildFinishedAt ??= now
        }
        // A refresh chained onto this work extends it; only the latest settle ends it.
        if (latest !== ready) {
          return
        }
        if (succeeded) {
          latestReadyAt = now
        }
        workSettled = true
        current.end()
      }
      void ready.then(
        () => settle(true),
        () => settle(false)
      )
    },
    origin() {
      if (kind === 'explicit') {
        return 'prefetch'
      }
      return prefetchRequested ? 'rearm_then_prefetch' : 'rearm'
    },
    timesAt(claimedAt) {
      // A create that waited for the work reports no idle time.
      return {
        buildMs: Math.max(0, (buildFinishedAt ?? claimedAt) - buildStartedAt),
        idleMs: Math.max(0, claimedAt - (latestReadyAt ?? claimedAt))
      }
    }
  }
}
