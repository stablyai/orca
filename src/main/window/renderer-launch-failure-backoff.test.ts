import { describe, expect, it } from 'vitest'
import {
  createRendererLaunchFailureBackoff,
  RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS
} from './renderer-launch-failure-backoff'

describe('createRendererLaunchFailureBackoff', () => {
  it('keeps the 250ms first retry and spreads the rest over about two minutes', () => {
    expect(RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS[0]).toBe(250)
    const total = RENDERER_LAUNCH_FAILURE_RETRY_DELAYS_MS.reduce((sum, ms) => sum + ms, 0)
    expect(total).toBeGreaterThanOrEqual(90_000)
    expect(total).toBeLessThanOrEqual(125_000)
  })

  it('walks the schedule, then reports it spent until reset', () => {
    const backoff = createRendererLaunchFailureBackoff([10, 20])
    expect(backoff.nextDelayMs()).toBe(10)
    expect(backoff.nextDelayMs()).toBe(20)
    expect(backoff.nextDelayMs()).toBeNull()
    expect(backoff.attempts()).toBe(2)
    backoff.reset()
    expect(backoff.attempts()).toBe(0)
    expect(backoff.nextDelayMs()).toBe(10)
  })
})
