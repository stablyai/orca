import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CONTROL_RTT_RESERVOIR_LIMIT,
  PRE_AUTH_RESERVOIR_LIMIT,
  RelayObservability,
  STICKY_CONNECTION_LIMIT,
  type RelayProcessCounts
} from './relay-observability.js'

const counts: RelayProcessCounts = {
  totalConnections: 9,
  preAuthConnections: 1,
  controls: 2,
  splices: 3,
  pendingSplices: 1,
  queuedBytes: 4096,
  databasePoolTotal: 3,
  databasePoolIdle: 0,
  databasePoolWaiting: 2,
  databasePoolWaitersMax: 3,
  databasePoolOldestWaitMs: 750,
  databasePoolWaitMsMax: 1_250
}

describe('relay observability', () => {
  afterEach(() => vi.restoreAllMocks())

  // Why: a director whose loop froze for 134 s still reported a 68 ms p99 (staging 2026-10-11).
  it('reports one long event-loop freeze as the window max', async () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    observability.start(() => counts, 3_600_000)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const frozenUntil = performance.now() + 300
    while (performance.now() < frozenUntil) {
      // Holds the loop the way a blocking connect() does.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
    observability.flush(counts)
    observability.stop()
    expect(entries[0]!.eventLoopDelayMsMax).toBeGreaterThanOrEqual(250)
  })

  it('bounds the per-connection sticky summary', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'director', cellId: 'director', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    for (let id = 1; id <= STICKY_CONNECTION_LIMIT + 3; id++) {
      observability.recordStickySlot({
        queueWaitMs: 0,
        poolWaitMs: 0,
        sqlMs: 1,
        statements: 1,
        statementMsByConnection: new Map([[id, [1]]])
      })
    }
    observability.flush(counts)

    expect(Object.keys(entries[0]?.stickySqlByConnection as object)).toHaveLength(
      STICKY_CONNECTION_LIMIT
    )
    expect(entries[0]).toMatchObject({ stickySqlConnectionSamplesDroppedDelta: 3 })
  })

  it('samples the whole flooded window rather than its first samples', () => {
    let seed = 42
    vi.spyOn(Math, 'random').mockImplementation(() => {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0
      return seed / 0x1_0000_0000
    })
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'production-gce-c28', region: 'asia-east2' },
      (entry) => entries.push(entry)
    )
    const half = CONTROL_RTT_RESERVOIR_LIMIT * 10
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(10)
    for (let sample = 0; sample < half; sample++) observability.recordControlRtt(900)
    observability.flush(counts)

    // A first-N reservoir would publish only the early 10 ms samples.
    expect(entries[0]!.controlRttMsP95).toBe(900)
    expect(entries[0]!.controlRttMsMax).toBe(900)
  })

  it('counts every hello in the pre-auth buckets, inclusive of each bound', () => {
    const entries: Array<Record<string, unknown>> = []
    const observability = new RelayObservability(
      { role: 'cell', cellId: 'staging-gce-c1', region: 'us-central1' },
      (entry) => entries.push(entry)
    )
    const flooded = PRE_AUTH_RESERVOIR_LIMIT * 5
    for (let sample = 0; sample < flooded; sample++) {
      observability.recordHostPreAuth('reserve', 'admitted', 450)
    }
    observability.recordHostPreAuth('reserve', 'admitted', 450.001)
    observability.recordHostPreAuth('reserve', 'admitted', 9_000)
    observability.flush(counts)

    expect(entries[0]).toMatchObject({
      preAuthLatencyMs: {
        reserve: {
          admitted: {
            // Exact past the reservoir cap, even when it declined the slowest hello.
            count: flooded + 2,
            max: 9_000,
            p50: 450,
            bucketsLeMs: { '300': 0, '450': flooded, '700': 1, '5000': 0, '+Inf': 1 }
          }
        }
      }
    })
  })
})
