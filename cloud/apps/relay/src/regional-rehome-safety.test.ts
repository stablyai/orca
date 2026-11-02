import { describe, expect, it } from 'vitest'
import {
  REGIONAL_REHOME_RECONNECTS_PER_CELL_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_LIMIT,
  REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS,
  REGIONAL_REHOME_SQL_FAILURES_SUSTAIN_MS,
  nextRegionalRehomeSqlFailuresBreach,
  regionalRehomeSafetyFailure,
  regionalRehomeSqlFailuresSustained,
  type RegionalRehomeSqlFailuresBreach
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
    // Zero tolerance rejects measured healthy-fleet micro-waits (1–2 waiters, ~1ms).
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
    // Asia’s 176ms RTT caused ~2000ms pool waits despite 0.2ms SQL; fleet Math.max must not gate all regions on that cell.
    expect(
      regionalRehomeSafetyFailure(
        safety({ databasePoolWaitersMax: 150, databasePoolWaitMsMax: 2_005 }),
        NOW,
        19
      )
    ).toBeNull()
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
    // Ambient retries peaked at 82/min; combined snapshots can span two windows.
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
    // Measured storm magnitude pins the threshold below real storms.
    expect(regionalRehomeSafetyFailure(safety({ sqlFailures: 395 }), NOW, 19)).toBe(
      'sql_failures'
    )
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

describe('regional rehome sql failure breach', () => {
  const STORM = REGIONAL_REHOME_SQL_FAILURES_LIMIT + 1
  function observe(samples: [at: number, sqlFailures: number][]): RegionalRehomeSqlFailuresBreach {
    let breach: RegionalRehomeSqlFailuresBreach = null
    for (const [at, sqlFailures] of samples) {
      breach = nextRegionalRehomeSqlFailuresBreach(breach, sqlFailures, NOW + at)
    }
    return breach
  }

  it('does not sustain a single-stall spike', () => {
    // 10-06 06:16Z: one 5-7 s stall published 396 for up to ~90 s.
    const spike = observe([[0, 396], [30_000, 396], [60_000, 396], [90_000, 396]])
    expect(spike && regionalRehomeSqlFailuresSustained(spike)).toBe(false)
    expect(observe([[0, 396], [90_000, 396], [96_000, 0]])).toBeNull()
  })

  it('sustains a breach watched for the whole window', () => {
    const samples: [number, number][] = []
    for (let at = 0; at <= REGIONAL_REHOME_SQL_FAILURES_SUSTAIN_MS; at += 6_000) samples.push([at, STORM])
    const breach = observe(samples)
    expect(breach && regionalRehomeSqlFailuresSustained(breach)).toBe(true)
  })

  it('restarts the window after an unwatched gap', () => {
    const breach = observe([
      [0, STORM],
      [REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS + 1, STORM],
      [REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS + 30_000, STORM]
    ])
    expect(breach?.since).toBe(NOW + REGIONAL_REHOME_SQL_FAILURES_OBSERVATION_GAP_MS + 1)
    expect(breach && regionalRehomeSqlFailuresSustained(breach)).toBe(false)
  })

  it('reports a latching reason over a concurrent sql spike', () => {
    expect(
      regionalRehomeSafetyFailure(safety({ sqlFailures: STORM, controlActivityRecoveryFailures: 1 }), NOW, 19)
    ).toBe('control_recovery_failures')
  })
})
