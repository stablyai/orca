import type { RegionalRehomeSafetySnapshot } from './relay-observability.js'

// Limits sit well above the healthy-fleet baseline measured in production on
// 2026-08-28 (peak 2 waiters / 1ms pool waits on every cell; up to ~80
// reconnects per published two-window row on the busiest cell). Sustained
// pool saturation still trips: waiters-max 16 is 8x baseline yet far under a
// backed-up pool, and 250ms peak wait is 1/10 of the incident-monitor alert.
// Instantaneous databasePoolWaiting is not checked separately: it is bounded
// by databasePoolWaitersMax within every published window.
export const REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT = 250
export const REGIONAL_REHOME_POOL_WAITERS_MAX_LIMIT = 16
export const REGIONAL_REHOME_POOL_WAIT_MS_MAX_LIMIT = 250

// Counted SQL failures are dominated by relay_cells 55P03 lock-timeout
// retries the transaction wrapper heals in place (Aug 25-28: ~1000 retried
// attempts per day vs ~30 exhausted, those clustered in one storm), so a
// zero bar disabled the worker on ambient noise just like the original pool
// bars. Fleet-wide ambient noise peaked at 82 counted failures per minute
// over four days; genuine database distress produced 395-457. The combined
// snapshot spans up to two 30s windows per process (pathological ambient
// alignment ~164), so 250 stays clear of noise while storms still trip.
// Terminal outages also trip the pool bars and the worker's own
// dispatch-failure budget; the sql bar only needs to catch storms.
export const REGIONAL_REHOME_SQL_FAILURES_LIMIT = 250
// Per-cell candidate cleanliness is a soft skip, not a durable latch; the
// worst ambient per-cell publish carried ~24 counted failures (two windows
// of 12). The fleet bar deliberately dominates: cells that are individually
// clean can sum past 250, and a fleet-wide sum at that scale is a storm.
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
  if (safety.sqlFailures > REGIONAL_REHOME_SQL_FAILURES_LIMIT) return 'sql_failures'
  if (regionalRehomePoolPressure(safety)) {
    return 'database_pool_pressure'
  }
  if (safety.controlActivityRecoveryFailures > 0) {
    return 'control_recovery_failures'
  }
  const reconnectLimit =
    Math.max(1, requiredCells) * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT
  if (safety.reconnects > reconnectLimit) return 'elevated_reconnects'
  return null
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
