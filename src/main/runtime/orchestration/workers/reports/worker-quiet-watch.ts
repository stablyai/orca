/** Watch only while eligible workers are working; push changes restart an idle watch. */
export function startWorkerQuietWatch(deps: {
  sweep: () => boolean
  subscribe: (wake: () => void) => () => void
}): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSweepAt: number | undefined
  let failures = 0
  let running = false
  let stopped = false
  const schedule = (delayMs: number): void => {
    timer = setTimeout(run, delayMs)
    timer.unref?.()
  }
  const run = (): void => {
    timer = undefined
    if (stopped) {
      return
    }
    lastSweepAt = performance.now()
    running = true
    try {
      const active = deps.sweep()
      failures = 0
      if (active && !stopped) {
        schedule(60_000)
      }
    } catch (error) {
      failures++
      console.warn('[orchestration] quiet worker sweep failed', error)
      if (!stopped) {
        schedule(Math.min(900_000, 60_000 * 2 ** Math.min(failures, 4)))
      }
    } finally {
      running = false
    }
  }
  const detach = deps.subscribe(() => {
    // Repeated status events must not postpone a deadline or bypass a failure backoff.
    if (!stopped && !running && timer === undefined) {
      schedule(Math.max(0, (lastSweepAt ?? -60_000) + 60_000 - performance.now()))
    }
  })
  schedule(0)
  return () => {
    stopped = true
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    detach()
  }
}
