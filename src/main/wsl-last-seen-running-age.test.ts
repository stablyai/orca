import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetWslBackgroundDistroGateForTests,
  wasWslDistroLastSeenRunningSettled
} from './wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from './wsl-running-distro-cache'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'Date'] })
})

afterEach(() => {
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.useRealTimers()
})

// #35387 review: WSL's own idle stop is reported by nothing, so an old list must not vouch for a distro.
describe('wasWslDistroLastSeenRunningSettled with an age bound', () => {
  it('trusts a fresh list and refuses one older than the bound', async () => {
    await resolveRunningWslDistros(async () => ['Ubuntu'], { requireConfirmed: true })

    vi.advanceTimersByTime(59_000)
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu', { maxAgeMs: 60_000 })).toBe(true)

    vi.advanceTimersByTime(2_000)
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu', { maxAgeMs: 60_000 })).toBe(false)
    // Callers without a bound keep today's answer.
    expect(wasWslDistroLastSeenRunningSettled('Ubuntu')).toBe(true)
  })
})
