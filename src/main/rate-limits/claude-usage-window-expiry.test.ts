import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { expireClaudeUsageWindows, hasClaudeUsageWindows } from './claude-usage-window-expiry'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function window(overrides: Partial<RateLimitWindow> = {}): RateLimitWindow {
  return {
    usedPercent: 40,
    windowMinutes: 300,
    resetsAt: NOW + HOUR,
    resetDescription: null,
    ...overrides
  }
}

function limits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: window(),
    weekly: window({ windowMinutes: 10080, resetsAt: NOW + 3 * 24 * HOUR }),
    fableWeekly: null,
    updatedAt: NOW - HOUR,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('expireClaudeUsageWindows', () => {
  it('returns the same object while every window is still ahead of its reset', () => {
    const input = limits()
    expect(expireClaudeUsageWindows(input, NOW)).toBe(input)
  })

  it('drops only the windows whose reset time has passed', () => {
    const result = expireClaudeUsageWindows(limits({ session: window({ resetsAt: NOW - 1 }) }), NOW)
    expect(result.session).toBeNull()
    expect(result.weekly?.usedPercent).toBe(40)
  })

  it('bounds a window without a reset time by its own length', () => {
    const noReset = limits({
      session: window({ resetsAt: null }),
      weekly: window({ windowMinutes: 10080, resetsAt: null }),
      updatedAt: NOW - 6 * HOUR
    })
    const result = expireClaudeUsageWindows(noReset, NOW)
    // 5h window recorded 6h ago cannot still be current; the 7d one can.
    expect(result.session).toBeNull()
    expect(result.weekly).not.toBeNull()
  })

  it('treats the Fable weekly window like the others', () => {
    const result = expireClaudeUsageWindows(
      limits({ fableWeekly: window({ windowMinutes: 10080, resetsAt: NOW - 1 }) }),
      NOW
    )
    expect(result.fableWeekly).toBeNull()
    expect(hasClaudeUsageWindows(result)).toBe(true)
    expect(
      hasClaudeUsageWindows(
        expireClaudeUsageWindows(
          limits({
            session: window({ resetsAt: NOW - 1 }),
            weekly: window({ resetsAt: NOW - 1 })
          }),
          NOW
        )
      )
    ).toBe(false)
  })
})
