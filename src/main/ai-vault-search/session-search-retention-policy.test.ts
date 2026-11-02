import { expect, it } from 'vitest'
import { sessionSearchHistoryCutoffMs } from './session-search-retention-policy'

const NOW = 1_740_000_000_000

it('treats sub-day or non-positive counts as unbounded and caps large counts', () => {
  expect(sessionSearchHistoryCutoffMs(0.4, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(0, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(-30, NOW)).toBeNull()
  expect(sessionSearchHistoryCutoffMs(30, NOW)).toBe(NOW - 30 * 86_400_000)
  expect(sessionSearchHistoryCutoffMs(999_999, NOW)).toBe(NOW - 3_650 * 86_400_000)
})

it('moves the cutoff with the clock', () => {
  const later = NOW + 86_400_000
  expect(sessionSearchHistoryCutoffMs(30, later)).toBe(
    (sessionSearchHistoryCutoffMs(30, NOW) ?? 0) + 86_400_000
  )
})
