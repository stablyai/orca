import { describe, expect, it } from 'vitest'
import { createPageInitiatedTabBudget } from './browser-page-initiated-tab-budget'

describe('page-initiated tab budget', () => {
  it('slides rather than resetting, so a paced flood cannot outrun the cap', () => {
    const budget = createPageInitiatedTabBudget(2, 1_000)

    expect(budget.tryConsume(0)).toBe(true)
    expect(budget.tryConsume(900)).toBe(true)
    expect(budget.tryConsume(1_000)).toBe(true)
    expect(budget.tryConsume(1_100)).toBe(false)
  })
})
