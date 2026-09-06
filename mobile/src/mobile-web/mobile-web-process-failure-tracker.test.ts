import { describe, expect, it } from 'vitest'
import { MobileWebProcessFailureTracker } from './mobile-web-process-failure-tracker'

describe('MobileWebProcessFailureTracker', () => {
  it('requests rollback on the third process loss inside one minute', () => {
    const tracker = new MobileWebProcessFailureTracker()

    expect(tracker.record('build-a', 1_000)).toBe(false)
    expect(tracker.record('build-a', 20_000)).toBe(false)
    expect(tracker.record('build-a', 40_000)).toBe(true)
  })

  it('isolates builds and expires old failures', () => {
    const tracker = new MobileWebProcessFailureTracker()

    expect(tracker.record('build-a', 1_000)).toBe(false)
    expect(tracker.record('build-b', 2_000)).toBe(false)
    expect(tracker.record('build-a', 62_000)).toBe(false)
    expect(tracker.record('build-a', 63_000)).toBe(false)
    expect(tracker.record('build-a', 64_000)).toBe(true)
  })

  it('clears history when the paired host changes', () => {
    const tracker = new MobileWebProcessFailureTracker()
    tracker.record('build-a', 1_000)
    tracker.record('build-a', 2_000)

    tracker.reset()

    expect(tracker.record('build-a', 3_000)).toBe(false)
  })
})
