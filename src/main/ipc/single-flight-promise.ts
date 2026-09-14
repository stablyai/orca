/** Collapses concurrent callers onto one run; the slot clears on settle so a
 *  later caller starts fresh. Shared by both watcher fallbacks. */
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
      // Self-comparison: a run settling after a newer one started must not clear it.
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
