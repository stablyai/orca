import { describe, expect, it } from 'vitest'
import { NestedRepoScanBudget } from './nested-repo-scan-budget'

describe('NestedRepoScanBudget', () => {
  it('accepts the exact path-memory capacity and rejects the next entry', () => {
    const budget = new NestedRepoScanBudget({ maxPathBytes: 258 })

    expect(budget.tryVisitEntry('a')).toBe(true)
    expect(budget.tryVisitEntry('b')).toBe(false)
    expect(budget.capacityReached).toBe(true)
  })

  it('accepts the exact ignore-rule capacity and rejects the next rule', () => {
    const budget = new NestedRepoScanBudget({ maxIgnoreBytes: 130 })

    expect(budget.tryRetainIgnoreRule('a')).toBe(true)
    expect(budget.tryRetainIgnoreRule('b')).toBe(false)
    expect(budget.capacityReached).toBe(true)
  })
})
