import { expect, it } from 'vitest'
import {
  normalizeSessionSearchHistoryDays,
  sessionSearchHistoryCutoffMs
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

// The cutoff is read from the clock on every pass, not frozen at construction:
// a purge and the accept check that follows it must not disagree about where
// the window is, or the sweep deletes rows the next candidate re-indexes.
it('moves the cutoff with the clock', () => {
  const later = NOW + 86_400_000
  expect(sessionSearchHistoryCutoffMs(30, later)).toBe(
    (sessionSearchHistoryCutoffMs(30, NOW) ?? 0) + 86_400_000
  )
})
