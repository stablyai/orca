/** Concurrent callers share one run; settlement clears the slot for later calls. */
export function createSingleFlight(): {
  run: (start: () => Promise<void>) => Promise<void>
  pending: () => Promise<void> | null
} {
  let inFlight: Promise<void> | null = null
  return {
    run: (start) => {
      if (inFlight) {
        return inFlight
      }
      // A settling run must not clear its successor.
      const tracked: Promise<void> = start().finally(() => {
        if (inFlight === tracked) {
          inFlight = null
        }
      })
      inFlight = tracked
      return tracked
    },
    pending: () => inFlight
  }
}
