const HOUR_MS = 60 * 60_000
/** This computer's own limits: a hostile workspace must not be able to flood the person or run a
 *  saved rule without bound, whatever the VM's broker claims to enforce. */
export const LOCAL_COMMAND_DESKTOP_LIMITS = {
  pendingPerWorkspace: 3,
  requestsPerHour: 60,
  autoRunsPerHour: 30,
  /** "Always allow" runs one at a time per workspace; a second one waits for the person. */
  autoRunsConcurrent: 1,
  /** A flood is logged once a minute, so it can't push real entries out of the audit log. */
  refusalLogIntervalMs: 60_000
} as const

type WorkspaceCounters = {
  requests: number[]
  autoRuns: number[]
  running: number
  lastRefusalLoggedAt: number
}

export function createLocalCommandRequestLimits() {
  const counters = new Map<string, WorkspaceCounters>()
  const of = (sandboxId: string): WorkspaceCounters => {
    let entry = counters.get(sandboxId)
    if (!entry) {
      entry = { requests: [], autoRuns: [], running: 0, lastRefusalLoggedAt: -Infinity }
      counters.set(sandboxId, entry)
    }
    return entry
  }
  const recent = (times: number[], now: number): number[] => times.filter((t) => now - t < HOUR_MS)

  return {
    /** Counts the request; false when this workspace already asked too often this hour. */
    admitRequest(sandboxId: string, now: number): boolean {
      const entry = of(sandboxId)
      entry.requests = recent(entry.requests, now)
      if (entry.requests.length >= LOCAL_COMMAND_DESKTOP_LIMITS.requestsPerHour) {
        return false
      }
      entry.requests.push(now)
      return true
    },
    /** Whether a saved rule may run now without asking; counts it when it may. */
    admitAutoRun(sandboxId: string, now: number): boolean {
      const entry = of(sandboxId)
      entry.autoRuns = recent(entry.autoRuns, now)
      if (
        entry.running >= LOCAL_COMMAND_DESKTOP_LIMITS.autoRunsConcurrent ||
        entry.autoRuns.length >= LOCAL_COMMAND_DESKTOP_LIMITS.autoRunsPerHour
      ) {
        return false
      }
      entry.autoRuns.push(now)
      return true
    },
    runStarted(sandboxId: string): void {
      of(sandboxId).running += 1
    },
    runEnded(sandboxId: string): void {
      const entry = of(sandboxId)
      entry.running = Math.max(0, entry.running - 1)
    },
    shouldLogRefusal(sandboxId: string, now: number): boolean {
      const entry = of(sandboxId)
      if (now - entry.lastRefusalLoggedAt < LOCAL_COMMAND_DESKTOP_LIMITS.refusalLogIntervalMs) {
        return false
      }
      entry.lastRefusalLoggedAt = now
      return true
    }
  }
}
