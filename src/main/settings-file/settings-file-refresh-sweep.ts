const SWEEP_MIN_MS = 30_000
const SWEEP_MAX_MS = 5 * 60_000

export type RefreshSweep = { stop: () => void }

// Headless runtimes have no focus event and a created or relinked file fires no watch event, so re-check
// on a timer that backs off while nothing changes and snaps back after a change.
export function startRefreshSweep(
  sweep: () => Promise<{ changed: boolean }>,
  minMs: number = SWEEP_MIN_MS
): RefreshSweep {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void sweep()
        .catch(() => ({ changed: false }))
        .then(({ changed }) => {
          if (!stopped) {
            schedule(changed ? minMs : Math.min(delayMs * 2, Math.max(SWEEP_MAX_MS, minMs)))
          }
        })
    }, delayMs)
    timer.unref?.()
  }
  schedule(minMs)
  return {
    stop: () => {
      stopped = true
      clearTimeout(timer)
    }
  }
}
