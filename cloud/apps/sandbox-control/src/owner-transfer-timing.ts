// How long each part of an owner hand-off took (OWNER-TRANSFER, TRANSFER-SLOW-N60). The desktop
// keeps its confirmation open until the whole request answers, so when that is slow this says
// which part was: one log line per completed hand-off, step names and milliseconds only. Never an
// id, a name or anything from the request.
export type StepTimer = {
  /** Runs `run` and adds its elapsed time to `name` (a step run twice is summed). */
  step<T>(name: string, run: () => Promise<T>): Promise<T>
  /** Milliseconds per step so far, in the order the steps first ran. */
  durations(): Record<string, number>
}

export function createStepTimer(clock: () => number): StepTimer {
  const elapsed = new Map<string, number>()
  return {
    async step(name, run) {
      const started = clock()
      try {
        return await run()
      } finally {
        // A step that throws is still counted: a slow failure is the interesting one.
        elapsed.set(name, (elapsed.get(name) ?? 0) + Math.max(0, clock() - started))
      }
    },
    durations: () => Object.fromEntries(elapsed)
  }
}

/**
 * The line for one completed hand-off. `patchMs` is the whole registry edit, which contains the
 * membership check and the stop; what is left of it is the owner write.
 */
export function ownerTransferTimingLine(durations: Record<string, number>, totalMs: number): string {
  const { patch = 0, membership = 0, suspend = 0, ...rest } = durations
  return JSON.stringify({
    event: 'owner_transfer_timing',
    totalMs: Math.max(0, totalMs),
    membershipMs: membership,
    suspendMs: suspend,
    writeMs: Math.max(0, patch - membership - suspend),
    ...Object.fromEntries(Object.entries(rest).map(([name, ms]) => [`${name}Ms`, ms]))
  })
}
