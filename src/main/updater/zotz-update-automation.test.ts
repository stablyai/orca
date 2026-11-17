import { describe, expect, it } from 'vitest'
import { ZotzServerIdleInstallClock } from './zotz-update-automation'

const MINUTE = 60_000

describe('ZotzServerIdleInstallClock', () => {
  it('installs only after 10 minutes in a row with no agent working', () => {
    const clock = new ZotzServerIdleInstallClock()
    expect(clock.shouldInstall(1, 0)).toBe(false)
    expect(clock.shouldInstall(0, 1 * MINUTE)).toBe(false)
    expect(clock.shouldInstall(0, 10 * MINUTE)).toBe(false)
    // An agent starts: the wait begins again from the next idle sample.
    expect(clock.shouldInstall(2, 10.5 * MINUTE)).toBe(false)
    expect(clock.shouldInstall(0, 12 * MINUTE)).toBe(false)
    expect(clock.shouldInstall(0, 21 * MINUTE)).toBe(false)
    expect(clock.shouldInstall(0, 22 * MINUTE)).toBe(true)
  })
})
