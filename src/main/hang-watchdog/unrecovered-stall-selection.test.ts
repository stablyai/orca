import { describe, expect, it } from 'vitest'
import type { HangObservation } from './hang-observation-schema'
import { findUnrecoveredStall } from './unrecovered-stall-selection'

function stall(parentPid: number, detectedAt: number, extra: Partial<HangObservation> = {}) {
  const record: HangObservation = {
    id: `${parentPid}:${detectedAt}:1`,
    kind: 'heartbeat-stall',
    detectedAt,
    parentPid,
    durationMs: 10_000,
    selfRecovered: false,
    initialSleepAssociated: false,
    snapshot: null,
    resolution: null,
    machine: null,
    completedSpans: null,
    powerEvents: [],
    tier: 'stall',
    ...extra
  }
  return record
}

describe('findUnrecoveredStall', () => {
  it("keeps run A's unrecovered stall when a later run B's open stall was ended by sleep", () => {
    const runA = stall(100, 1_000)
    const runB = stall(200, 2_000, {
      powerEvents: [{ event: 'suspend', observedAt: 2_500, receivedAt: 2_500 }]
    })
    expect(findUnrecoveredStall([runA, runB])).toBe(runA)
  })
})
