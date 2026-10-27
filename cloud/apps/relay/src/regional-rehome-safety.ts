import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'

// Healthy-fleet peaks: 2 waiters/~1ms pool wait; ~80 reconnects per two-window row (2026-08-28).
export const REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT = 250

// Gate pool pressure per cell: fleet Math.max would stop every region on one narrow Asia pool (176ms RTT, ~2000ms waits, 0.2ms SQL).
// Candidate checks exclude it as source/target; instantaneous waiters are already bounded by the window maximum.
export const REGIONAL_REHOME_POOL_WAITERS_MAX_LIMIT = 16
export const REGIONAL_REHOME_POOL_WAIT_MS_MAX_LIMIT = 250

// Ambient retried 55P03s peak at 82/min (~164 across two windows), versus 395–457 in storms; 250 separates them.
// Pool bars and dispatch-failure budgets cover terminal outages; this bar catches storms.
export const REGIONAL_REHOME_SQL_FAILURES_LIMIT = 250
// 40 exceeds ambient per-cell ~24/two windows; soft skips stay below the durable fleet storm bar of 250.
export const REGIONAL_REHOME_SQL_FAILURES_PER_CELL_LIMIT = 40

export function regionalRehomePoolPressure(safety: {
  databasePoolWaitersMax: number
  databasePoolWaitMsMax: number
}): boolean {
  return (
    safety.databasePoolWaitersMax > REGIONAL_REHOME_POOL_WAITERS_MAX_LIMIT ||
    safety.databasePoolWaitMsMax > REGIONAL_REHOME_POOL_WAIT_MS_MAX_LIMIT
  )
}

export function regionalRehomeSafetyFailure(
  safety: RegionalRehomeSafetySnapshot,
  now: number,
  requiredCells: number
): string | null {
  if (safety.observedAt === 0 || now - safety.observedAt > 60_000) {
    return 'monitoring_stale'
  }
  if (safety.controlActivityRecoveryFailures > 0) {
    return 'control_recovery_failures'
  }
  const reconnectLimit =
    Math.max(1, requiredCells) * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT
  if (safety.reconnects > reconnectLimit) return 'elevated_reconnects'
  // Last, so 'sql_failures' means no latching reason also failed.
  if (safety.sqlFailures > REGIONAL_REHOME_SQL_FAILURES_LIMIT) return 'sql_failures'
  return null
}

// Routine 5–7s DB stalls leave SQL sums elevated ~90s through two windows and heartbeat lag; pause claims, latch only sustained breaches.
export const REGIONAL_REHOME_SQL_FAILURES_SUSTAIN_MS = 150_000
// The director polls every ~6 s; a longer silence means the breach was not watched.
export const REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS = 45_000

export type RegionalRehomeSqlFailuresBreach = { since: number; lastSeenAt: number } | null

export function nextRegionalRehomeSqlFailuresBreach(
  breach: RegionalRehomeSqlFailuresBreach,
  sqlFailures: number,
  now: number
): RegionalRehomeSqlFailuresBreach {
  if (sqlFailures <= REGIONAL_REHOME_SQL_FAILURES_LIMIT) return null
  if (!breach || now - breach.lastSeenAt > REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS) {
    return { since: now, lastSeenAt: now }
  }
  return { since: breach.since, lastSeenAt: now }
}

export function regionalRehomeSqlFailuresSustained(
  breach: NonNullable<RegionalRehomeSqlFailuresBreach>
): boolean {
  return breach.lastSeenAt - breach.since >= REGIONAL_REHOME_SQL_FAILURES_SUSTAIN_MS
}

export function combineRegionalRehomeSafety(
  processSafety: RegionalRehomeSafetySnapshot,
  fleetSafety: RegionalRehomeSafetySnapshot
): RegionalRehomeSafetySnapshot {
  return {
    observedAt: Math.min(processSafety.observedAt, fleetSafety.observedAt),
    sqlFailures: processSafety.sqlFailures + fleetSafety.sqlFailures,
    reconnects: fleetSafety.reconnects,
    controlActivityRecoveryFailures:
      processSafety.controlActivityRecoveryFailures +
      fleetSafety.controlActivityRecoveryFailures,
    databasePoolWaiting: Math.max(
      processSafety.databasePoolWaiting,
      fleetSafety.databasePoolWaiting
    ),
    databasePoolWaitersMax: Math.max(
      processSafety.databasePoolWaitersMax,
      fleetSafety.databasePoolWaitersMax
    ),
    databasePoolWaitMsMax: Math.max(
      processSafety.databasePoolWaitMsMax,
      fleetSafety.databasePoolWaitMsMax
    )
  }
}
