import { describe, expect, it } from 'vitest'
import { isStaleClaudeUsageWindow } from './claude-usage-window'
import type { RateLimitWindow } from '../../shared/rate-limit-types'

const NOW = 1_800_000_000_000
const HOUR = 60 * 60 * 1000

function usageWindow(usedPercent: number, resetsAt: number | null): RateLimitWindow {
  return { usedPercent, windowMinutes: 300, resetsAt, resetDescription: null }
}

describe('isStaleClaudeUsageWindow', () => {
  it('rejects a lower value for the same window', () => {
    expect(
      isStaleClaudeUsageWindow(usageWindow(99, NOW + HOUR), usageWindow(91, NOW + HOUR + 800), NOW)
    ).toBe(true)
  })

  it('rejects a snapshot from an earlier window', () => {
    expect(
      isStaleClaudeUsageWindow(usageWindow(5, NOW + 4 * HOUR), usageWindow(97, NOW + HOUR), NOW)
    ).toBe(true)
  })

  it('accepts growth within the window and a new window after a reset', () => {
    expect(
      isStaleClaudeUsageWindow(usageWindow(91, NOW + HOUR), usageWindow(99, NOW + HOUR), NOW)
    ).toBe(false)
    expect(
      isStaleClaudeUsageWindow(usageWindow(99, NOW + HOUR), usageWindow(2, NOW + 5 * HOUR), NOW)
    ).toBe(false)
  })

  it('accepts anything when a reset time is unknown or the previous window has ended', () => {
    expect(isStaleClaudeUsageWindow(usageWindow(99, null), usageWindow(10, NOW + HOUR), NOW)).toBe(
      false
    )
    expect(isStaleClaudeUsageWindow(usageWindow(99, NOW + HOUR), usageWindow(10, null), NOW)).toBe(
      false
    )
    expect(
      isStaleClaudeUsageWindow(usageWindow(99, NOW - 1000), usageWindow(10, NOW - 1000), NOW)
    ).toBe(false)
    expect(isStaleClaudeUsageWindow(null, usageWindow(10, NOW + HOUR), NOW)).toBe(false)
  })
})
