import { describe, expect, it } from 'vitest'
import {
  createPageInitiatedTabBudget,
  MAX_PAGE_INITIATED_TABS_PER_WINDOW,
  PAGE_INITIATED_TAB_WINDOW_MS
} from './browser-page-initiated-tab-budget'

describe('page-initiated tab budget', () => {
  it('absorbs a window.open loop fired from a single activation', () => {
    const budget = createPageInitiatedTabBudget()
    const granted = Array.from({ length: 12 }, () => budget.tryConsume(1_000)).filter(Boolean)

    expect(granted).toHaveLength(MAX_PAGE_INITIATED_TABS_PER_WINDOW)
  })

  it('refills once the rolling window has passed, so real browsing is unaffected', () => {
    const budget = createPageInitiatedTabBudget()
    for (let i = 0; i < MAX_PAGE_INITIATED_TABS_PER_WINDOW; i++) {
      expect(budget.tryConsume(1_000)).toBe(true)
    }
    expect(budget.tryConsume(1_000 + PAGE_INITIATED_TAB_WINDOW_MS - 1)).toBe(false)
    expect(budget.tryConsume(1_000 + PAGE_INITIATED_TAB_WINDOW_MS)).toBe(true)
  })

  it('slides rather than resetting, so a paced flood cannot outrun the cap', () => {
    const budget = createPageInitiatedTabBudget(2, 1_000)

    expect(budget.tryConsume(0)).toBe(true)
    expect(budget.tryConsume(900)).toBe(true)
    // The first grant has aged out by 1_000 but the second has not.
    expect(budget.tryConsume(1_000)).toBe(true)
    expect(budget.tryConsume(1_100)).toBe(false)
  })
})
