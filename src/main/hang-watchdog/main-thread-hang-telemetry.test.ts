import { describe, expect, it } from 'vitest'
import { eventSchemas } from '../../shared/telemetry-events'

describe('main_thread_hang_detected telemetry schema', () => {
  // Strict schema excludes paths, PIDs and window titles from telemetry.
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
