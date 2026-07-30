import { describe, expect, it } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'

describe('main_thread_hang_detected telemetry schema', () => {
  it('accepts an unresolved hang', () => {
    expect(
      eventSchemas.main_thread_hang_detected.safeParse({
        unresponsive_ms: 50_000,
        self_recovered: false
      }).success
    ).toBe(true)
  })

  it('accepts a self-recovered stall', () => {
    expect(
      eventSchemas.main_thread_hang_detected.safeParse({
        unresponsive_ms: 61_000,
        self_recovered: true
      }).success
    ).toBe(true)
  })

  // Why: strict() keeps unplanned fields (paths, pids, window titles) off the wire.
  it('rejects unknown fields and non-integer durations', () => {
    expect(
      eventSchemas.main_thread_hang_detected.safeParse({
        unresponsive_ms: 50_000,
        self_recovered: false,
        parent_pid: 4242
      }).success
    ).toBe(false)
    expect(
      eventSchemas.main_thread_hang_detected.safeParse({
        unresponsive_ms: 50_000.5,
        self_recovered: false
      }).success
    ).toBe(false)
  })
})
