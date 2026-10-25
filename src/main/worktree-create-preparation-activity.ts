import type { PreparedCheckoutOrigin } from '../shared/worktree/create-types'
import { beginPreparationWork, type PreparationWork } from './worktree-create-concurrency'

/** Record preparation origin and disk timing without controlling the pool. */
export type PreparationActivity = {
  /** Counts the latest build or refresh as disk work competing with creates. */
  readonly work: PreparationWork
  requestedByPrefetch(): void
  /** Track disk work through the latest build or tip refresh. */
  track(ready: Promise<void>): void
  origin(): PreparedCheckoutOrigin
  /** Build ends at first ready; idle runs from latest ready until claim. */
  timesAt(claimedAt: number): { buildMs: number; idleMs: number }
}

export function createPreparationActivity(kind: 'explicit' | 'automatic'): PreparationActivity {
  let work = beginPreparationWork()
  let workSettled = false
  // A later refresh must not restart the original build timer.
  const buildStartedAt = performance.now()
  let buildFinishedAt: number | undefined
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
      return {
        buildMs: Math.max(0, (buildFinishedAt ?? claimedAt) - buildStartedAt),
        idleMs: Math.max(0, claimedAt - (latestReadyAt ?? claimedAt))
      }
    }
  }
}
