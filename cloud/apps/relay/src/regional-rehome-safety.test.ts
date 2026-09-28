import { describe, expect, it } from 'vitest'
import {
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_LIMIT,
  regionalRehomeSafetyFailure
} from './regional-rehome-safety.js'

const NOW = 1_787_900_000_000

function safety(overrides: Partial<Parameters<typeof regionalRehomeSafetyFailure>[0]> = {}) {
  return {
    observedAt: NOW - 1_000,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0,
    ...overrides
  }
}

describe('regionalRehomeSafetyFailure', () => {
  it('passes the measured healthy-fleet baseline of pool micro-waits', () => {
    // Every production cell idles at 1-2 peak waiters resolved in ~1ms; a
    // zero-tolerance bar here disables the worker on its first tick.
    expect(
      regionalRehomeSafetyFailure(
        safety({ databasePoolWaitersMax: 2, databasePoolWaitMsMax: 1 }),
        NOW,
        19
      )
    ).toBeNull()
  })

  it('passes routine client reconnect churn', () => {
    expect(
      regionalRehomeSafetyFailure(safety({ reconnects: 19 * 80 }), NOW, 19)
    ).toBeNull()
  })

  it('passes asia-scale pool pressure, which excludes a cell rather than the fleet', () => {
    // Measured 2026-09-16 on the asia-east2 cells: a client pool too narrow for
    // a 176ms round trip, with 0.2ms server-side execution. The fleet snapshot
    // is a Math.max, so gating on it here stops every region.
    expect(
      regionalRehomeSafetyFailure(
        safety({ databasePoolWaitersMax: 150, databasePoolWaitMsMax: 2_005 }),
        NOW,
        19
      )
    ).toBeNull()
    // Every other bar still fails closed at that same pool pressure.
    for (const [overrides, reason] of [
      [{ sqlFailures: REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1 }, 'sql_failures'],
      [{ controlActivityRecoveryFailures: 1 }, 'control_recovery_failures'],
      [
        { reconnects: 19 * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT + 1 },
        'elevated_reconnects'
      ],
      [{ observedAt: 0 }, 'monitoring_stale']
    ] as const) {
      expect(
        regionalRehomeSafetyFailure(
          safety({
            databasePoolWaitersMax: 150,
            databasePoolWaitMsMax: 2_005,
            ...overrides
          }),
          NOW,
          19
        )
      ).toBe(reason)
    }
  })

  it('still fails closed on a reconnect storm', () => {
    expect(
      regionalRehomeSafetyFailure(
        safety({ reconnects: 19 * REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT + 1 }),
        NOW,
        19
      )
    ).toBe('elevated_reconnects')
  })

  it('passes ambient 55P03 retry noise', () => {
    // Fleet-wide retried lock timeouts peaked at 82 counted failures per
    // minute over Aug 25-28; the combined snapshot can span two windows.
    expect(regionalRehomeSafetyFailure(safety({ sqlFailures: 164 }), NOW, 19)).toBeNull()
  })

  it('still fails closed on a sql failure storm', () => {
    expect(
      regionalRehomeSafetyFailure(
        safety({ sqlFailures: REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1 }),
        NOW,
        19
      )
    ).toBe('sql_failures')
    // Literal storm magnitude (measured 2026-08-28) pins the bar itself: the
    // limit must sit below real storm scale, not merely exist.
    expect(regionalRehomeSafetyFailure(safety({ sqlFailures: 395 }), NOW, 19)).toBe(
      'sql_failures'
    )
    // The bar is exclusive: exactly at the limit still passes.
    expect(
      regionalRehomeSafetyFailure(
        safety({ sqlFailures: REGIONAL_REHOME_SQL_FAILURES_LIMIT }),
        NOW,
        19
      )
    ).toBeNull()
  })

  it('keeps zero-tolerance for real failure signals', () => {
    expect(
      regionalRehomeSafetyFailure(
        safety({ controlActivityRecoveryFailures: 1 }),
        NOW,
        19
      )
    ).toBe('control_recovery_failures')
    expect(regionalRehomeSafetyFailure(safety({ observedAt: 0 }), NOW, 19)).toBe(
      'monitoring_stale'
    )
    expect(
      regionalRehomeSafetyFailure(safety({ observedAt: NOW - 61_000 }), NOW, 19)
    ).toBe('monitoring_stale')
  })
})
