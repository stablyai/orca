/**
 * Route-level quarantine with exponential back-off. A killed helper cannot
 * report late success, so a stalled route's recovery is only probeable: block
 * admissions briefly, let the next real task be the probe, escalate on repeat.
 */

const ROUTE_RETRY_DELAY_MULTIPLIER = 2
// A short first strike lets a cold-booting distro recover on the next poll.
export const WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS = 5_000
// Strikes older than this stop escalating: a distro that wakes slowly once a
// day must restart from the base window, not resume yesterday's back-off.
export const WSL_TRANSCRIPT_FS_ROUTE_STRIKE_DECAY_MS = 5 * 60_000

type RouteQuarantine = { until: number; strikes: number; setAt: number }
// Monotonic clock: wall time would misjudge the window across sleep/NTP steps.
const blockedRoutes = new Map<string, RouteQuarantine>()

export function routeIsBlocked(route: string): boolean {
  const blocked = blockedRoutes.get(route)
  // Expired entries persist: their strike count seeds the next back-off.
  return blocked !== undefined && performance.now() < blocked.until
}

/**
 * One more strike: block the route with doubled back-off, capped by deadline.
 * `taskStartedAt` identifies the incident — the exact and scan lanes usually
 * both stall on one hung mount, and a task admitted before the current
 * quarantine was set is the sibling lane reporting that same stall, so it
 * re-arms the window without escalating the strike count.
 */
export function quarantineRoute(route: string, deadlineMs: number, taskStartedAt: number): void {
  const now = performance.now()
  const previous = blockedRoutes.get(route)
  const seed =
    previous !== undefined && now - previous.until <= WSL_TRANSCRIPT_FS_ROUTE_STRIKE_DECAY_MS
      ? previous
      : undefined
  const sameIncident = seed !== undefined && taskStartedAt <= seed.setAt
  const strikes = seed === undefined ? 1 : sameIncident ? seed.strikes : seed.strikes + 1
  const quarantineMs = Math.min(
    WSL_TRANSCRIPT_FS_ROUTE_QUARANTINE_BASE_MS * 2 ** (strikes - 1),
    deadlineMs * ROUTE_RETRY_DELAY_MULTIPLIER
  )
  blockedRoutes.set(route, {
    until: Math.max(seed?.until ?? 0, now + quarantineMs),
    strikes,
    setAt: sameIncident ? seed.setAt : now
  })
}

/** A real filesystem answer proves the mount is alive: forget the strikes. */
export function liftRouteQuarantine(route: string): void {
  blockedRoutes.delete(route)
}

export function resetRouteQuarantinesForTests(): void {
  blockedRoutes.clear()
}
