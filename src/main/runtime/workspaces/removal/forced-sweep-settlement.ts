import { describeError } from './unstopped-pty-verification'

// Give timed-out shutdowns a brief handle-release grace without granting Force Delete a second full budget.
export const ABANDONED_SWEEP_GRACE_MS = 2_000

export type WorktreeSweepTracker = {
  track: <T>(run: () => Promise<T>) => () => Promise<T>
  /** True if any sweep remains running after the grace. */
  awaitAbandonedSweeps: (graceMs?: number) => Promise<boolean>
}

/** Deadlines abandon rather than cancel sweeps; retain the real promises before forced file deletion. */
export function createWorktreeSweepTracker(): WorktreeSweepTracker {
  const running = new Set<Promise<unknown>>()
  return {
    track:
      <T>(run: () => Promise<T>) =>
      () => {
        const sweep = run()
        running.add(sweep)
        // Observe late rejection after callers abandon the sweep.
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

/** #11960: await all real sweeps, including timed-out ones, so first rejection cannot abandon sibling handle release. */
export async function settleSweepsForForcedRemoval(
  worktreeId: string,
  sweeps: WorktreeSweepPromises,
  tracker: WorktreeSweepTracker,
  deadlineError: Error
): Promise<ForcedSweepSettlement> {
  const settled = await Promise.allSettled([sweeps.runtime, sweeps.provider, sweeps.registry])
  const [runtimeSettled, providerSettled, registrySettled] = settled
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
  // #11960: explicit Force Delete survives incomplete sweeps; log specific causes before generic timeout.
  // This is the only trace when files are deleted without proving any stop.
  const detail = [
    ...reasons.filter((candidate) => candidate !== deadlineError),
    ...reasons.filter((candidate) => candidate === deadlineError)
  ].map(describeError)
  if (stillRunning) {
    // Bound the grace, but report surviving handles: Windows/WSL deletion may remain incomplete.
    detail.push(
      `a sweep was still running after the ${ABANDONED_SWEEP_GRACE_MS}ms grace, so its PTY handles may outlive the delete`
    )
  }
  console.warn(
    `[worktree-teardown] forcing removal after an incomplete PTY sweep for ${worktreeId} — ${detail.join('; ')}`
  )
  // Force deletes regardless and clears no registry rows; skipping remaining PTY verdicts costs diagnosability.
  return { stopped, incomplete: reasons.length > 0 }
}
