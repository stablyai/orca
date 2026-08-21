import { describeError } from './unstopped-pty-verification'

// Why: an abandoned sweep is one whose provider ignored the deadline it was already given,
// so this is a second chance, not a second budget — long enough for a shutdown() that is
// mid-kill to finish releasing handles, short enough that Force Delete still feels forced.
export const ABANDONED_SWEEP_GRACE_MS = 2_000

export type WorktreeSweepTracker = {
  /** Wraps a sweep body so the promise stays observable after its deadline abandons it. */
  track: <T>(run: () => Promise<T>) => () => Promise<T>
  /** Resolves when every tracked sweep settled, or the grace expired; true if one is still running. */
  awaitAbandonedSweeps: (graceMs?: number) => Promise<boolean>
}

/**
 * Keeps the real sweep promises reachable after `settleBeforeDeadline` stops waiting on them.
 *
 * Why: that helper rejects on its timer without cancelling `run()`, so by construction the
 * deadline error can only fire while work is still in flight — and forced removal deletes
 * the worktree directory the moment teardown returns.
 */
export function createWorktreeSweepTracker(): WorktreeSweepTracker {
  const running = new Set<Promise<unknown>>()
  return {
    track:
      <T>(run: () => Promise<T>) =>
      () => {
        const sweep = run()
        running.add(sweep)
        // Why: the tracked copy is observed here too, so a rejection this call abandons
        // never surfaces as an unhandled rejection in whatever ran next.
        void sweep.catch(() => undefined).finally(() => running.delete(sweep))
        return sweep
      },
    awaitAbandonedSweeps: async (graceMs = ABANDONED_SWEEP_GRACE_MS) => {
      const pending = [...running]
      if (pending.length === 0) {
        return false
      }
      let expiry: ReturnType<typeof setTimeout> | undefined
      const expired = new Promise<true>((resolve) => {
        expiry = setTimeout(() => resolve(true), graceMs)
        expiry.unref?.()
      })
      const stillRunning = await Promise.race([
        Promise.allSettled(pending).then(() => false),
        expired
      ])
      clearTimeout(expiry)
      return stillRunning
    }
  }
}

export type WorktreeSweepPromises = {
  runtime: Promise<{ stopped: number }>
  provider: Promise<number>
  registry: Promise<number>
}

export type ForcedSweepSettlement = {
  stopped: { runtimeStopped: number; providerStopped: number; registryStopped: number }
  /** A sweep failed outright, so no per-PTY verdict below it can be trusted. */
  incomplete: boolean
}

/**
 * Reconciles the three sweeps for a removal carrying the Force Delete waiver (#11960).
 *
 * Force goes on to delete files, so every sweep must finish releasing handles first —
 * `Promise.all` would abandon the siblings of the first rejection while they were still
 * inside shutdown(). Waiting on the tracked promises rather than only on their deadline
 * wrappers is what makes that true for the timeout case as well.
 */
export async function settleSweepsForForcedRemoval(
  worktreeId: string,
  sweeps: WorktreeSweepPromises,
  tracker: WorktreeSweepTracker,
  deadlineError: Error
): Promise<ForcedSweepSettlement> {
  const settled = await Promise.allSettled([sweeps.runtime, sweeps.provider, sweeps.registry])
  const [runtimeSettled, providerSettled, registrySettled] = settled
  // Report what the surviving sweeps actually stopped rather than a flat zero.
  const stopped = {
    runtimeStopped: runtimeSettled.status === 'fulfilled' ? runtimeSettled.value.stopped : 0,
    providerStopped: providerSettled.status === 'fulfilled' ? providerSettled.value : 0,
    registryStopped: registrySettled.status === 'fulfilled' ? registrySettled.value : 0
  }
  const reasons = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason as unknown] : []
  )
  const stillRunning = await tracker.awaitAbandonedSweeps()
  if (reasons.length === 0 && !stillRunning) {
    return { stopped, incomplete: false }
  }
  // Why (#11960): a sweep that cannot even complete — unresponsive daemon, dropped SSH
  // channel — fails before the unproven-stop gate could offer its escape hatch, so an
  // explicit Force Delete has to survive it. Report every reason, specific ones first: the
  // shared deadline sentinel only says that *something* timed out, so leading with it would
  // bury the provider error that actually explains the failure. This warning is the only
  // trace of a removal that deleted files without proving a single stop.
  const detail = [
    ...reasons.filter((candidate) => candidate !== deadlineError),
    ...reasons.filter((candidate) => candidate === deadlineError)
  ].map(describeError)
  if (stillRunning) {
    // Force must never wedge, so the wait is bounded — but "we stopped waiting" is not
    // "handles released", and on Windows/WSL that is the difference between a clean
    // removal and a half-deleted directory. Say so instead of implying the sweep finished.
    detail.push(
      `a sweep was still running after the ${ABANDONED_SWEEP_GRACE_MS}ms grace, so its PTY handles may outlive the delete`
    )
  }
  console.warn(
    `[worktree-teardown] forcing removal after an incomplete PTY sweep for ${worktreeId} — ${detail.join('; ')}`
  )
  // Reporting `incomplete` does skip the per-PTY verdict, which could still have named live
  // PTYs when only one sweep failed — accepted for now because this path is behind an
  // explicit Force Delete, deletes either way, and clears no registry rows, so the cost is
  // diagnosability rather than safety.
  return { stopped, incomplete: reasons.length > 0 }
}
