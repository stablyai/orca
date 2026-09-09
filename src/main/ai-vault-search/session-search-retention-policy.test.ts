import { expect, it } from 'vitest'
import {
  narrowsSessionSearchHistory,
  normalizeSessionSearchHistoryDays,
  sessionSearchHistoryCutoffMs,
  widensSessionSearchHistory
} from './session-search-retention-policy'

const NOW = 1_740_000_000_000

it('treats a fractional or non-positive day count as no bound at all', () => {
  // A day count that floors to zero would read as "all history" in one place
  // and "cutoff is now" in the other; both sides answer null.
  expect(normalizeSessionSearchHistoryDays(0.4)).toBeNull()
  expect(normalizeSessionSearchHistoryDays(0)).toBeNull()
  expect(normalizeSessionSearchHistoryDays(-30)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(0.4, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(30, NOW)).toBe(NOW - 30 * 86_400_000)
  expect(normalizeSessionSearchHistoryDays(999_999)).toBe(3_650)
})

it('separates a narrowing bound from a widening one, including to and from unbounded', () => {
  expect(narrowsSessionSearchHistory(null, 30)).toBe(true)
  expect(narrowsSessionSearchHistory(90, 30)).toBe(true)
  expect(narrowsSessionSearchHistory(30, 90)).toBe(false)
  expect(narrowsSessionSearchHistory(30, null)).toBe(false)

  expect(widensSessionSearchHistory(30, 90)).toBe(true)
  expect(widensSessionSearchHistory(30, null)).toBe(true)
  expect(widensSessionSearchHistory(null, 30)).toBe(false)
  expect(widensSessionSearchHistory(30, 30)).toBe(false)
})
