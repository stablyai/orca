// Local reads finish in milliseconds; this bounds only unreachable network locations.
const DISCOVERY_DEADLINE_MS = 1_000

export const TIMED_OUT = Symbol('timed-out')

/** One search's shared time budget: an unresponsive share can stall readdir or stat indefinitely. */
export type DiscoveryBudget = {
  expiry: Promise<typeof TIMED_OUT>
  expired: boolean
  /** Something was cut off, so an empty result is not a confirmed miss. */
  incomplete: boolean
  stop: () => void
}

export function startDiscoveryBudget(): DiscoveryBudget {
  let timer: ReturnType<typeof setTimeout> | undefined
  const budget: DiscoveryBudget = {
    expired: false,
    incomplete: false,
    expiry: new Promise((resolve) => {
      timer = setTimeout(() => {
        budget.expired = true
        resolve(TIMED_OUT)
      }, DISCOVERY_DEADLINE_MS)
      timer.unref?.()
    }),
    stop: () => clearTimeout(timer)
  }
  return budget
}

/** Stops waiting at the deadline; the read itself cannot be cancelled and finishes in the background. */
export function within<T>(
  budget: DiscoveryBudget,
  work: () => Promise<T>
): Promise<T | typeof TIMED_OUT> {
  if (budget.expired) {
    budget.incomplete = true
    return Promise.resolve(TIMED_OUT)
  }
  return Promise.race([work(), budget.expiry]).then((result) => {
    if (result === TIMED_OUT) {
      budget.incomplete = true
    }
    return result
  })
}
