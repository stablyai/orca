import { describe, expect, it } from 'vitest'
import {
  IntegrationPaginationBudget,
  IntegrationPaginationLimitError
} from './integration-pagination-budget'

describe('IntegrationPaginationBudget', () => {
  it('admits exact page and item boundaries and rejects page +1', () => {
    const budget = new IntegrationPaginationBudget({
      maxPages: 1,
      maxItems: 2,
      maxRetainedBytes: 100
    })

    expect(budget.admitPage(['a', 'b'])).toBe(true)
    expect(budget.canRequestPage).toBe(false)
    expect(budget.admitPage([])).toBe(false)
  })

  it('admits the exact retained-byte boundary and rejects byte +1', () => {
    const exact = new IntegrationPaginationBudget({
      maxPages: 2,
      maxItems: 2,
      maxRetainedBytes: 5
    })
    const over = new IntegrationPaginationBudget({
      maxPages: 2,
      maxItems: 2,
      maxRetainedBytes: 5
    })

    expect(exact.admitPage(['a'])).toBe(true)
    expect(over.admitPage(['aa'])).toBe(false)
  })

  it('does not consume capacity when a page is rejected', () => {
    const budget = new IntegrationPaginationBudget({
      maxPages: 1,
      maxItems: 1,
      maxRetainedBytes: 5
    })

    expect(budget.admitPage(['aa'])).toBe(false)
    expect(budget.admitPage(['a'])).toBe(true)
  })

  it('bounds SDK-style cumulative pages at exact and +1 byte sizes', () => {
    const exact = new IntegrationPaginationBudget({
      maxPages: 2,
      maxItems: 2,
      maxRetainedBytes: 5
    })
    const over = new IntegrationPaginationBudget({
      maxPages: 2,
      maxItems: 2,
      maxRetainedBytes: 5
    })

    expect(() => exact.assertCumulativePage(['a'])).not.toThrow()
    expect(() => over.assertCumulativePage(['aa'])).toThrow(IntegrationPaginationLimitError)
  })
})
