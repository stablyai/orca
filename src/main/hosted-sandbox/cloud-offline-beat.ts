// Background delivery for queued Orca Cloud prompts runs only while prompts are owed: at the next
// due attempt, never sooner than the base cadence, doubling while a pass changes nothing.
export type OwedWorkBeat = {
  /** Something changed (a prompt was queued or settled): arm at the base cadence again. */
  poke(): void
  /** Run a pass now (startup), then keep the cadence while work is owed. */
  runNow(): Promise<void>
  dispose(): void
}

export function createOwedWorkBeat(options: {
  /** Earliest owed attempt (ms epoch), or null when nothing is owed: the beat stops. */
  nextDueAt: () => number | null
  pass: () => Promise<void>
  baseMs: number
  maxBackoffSteps: number
  now?: () => number
}): OwedWorkBeat {
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setTimeout> | null = null
  let idlePasses = 0
  let disposed = false

  function arm(): void {
    const due = options.nextDueAt()
    if (timer || disposed || due === null) {
      return
    }
    const idleDelay = options.baseMs * 2 ** Math.min(idlePasses, options.maxBackoffSteps)
    timer = setTimeout(() => void runNow(), Math.max(due - now(), idleDelay))
    timer.unref?.()
  }

  async function runNow(): Promise<void> {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    const before = options.nextDueAt()
    await options.pass()
    idlePasses = options.nextDueAt() === before ? idlePasses + 1 : 0
    arm()
  }

  return {
    poke() {
      idlePasses = 0
      arm()
    },
    runNow,
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    }
  }
}
