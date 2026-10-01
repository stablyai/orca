import { describe, expect, it } from 'vitest'
import { MAX_CODEX_TOKEN_USAGE_THREADS } from './codex-structured-journal-limits'
import { CodexThreadTokenTotals } from './codex-thread-token-totals'

describe('CodexThreadTokenTotals', () => {
  it("replaces a thread's total with its newest report instead of summing reports", () => {
    const totals = new CodexThreadTokenTotals()
    totals.record('child-1', 100)
    totals.record('child-1', 250)
    expect(totals.get('child-1')).toBe(250)
  })

  it('evicts by recency of report, so a thread still reporting outlives quieter ones', () => {
    const totals = new CodexThreadTokenTotals()
    totals.record('child-1', 1)
    for (let index = 0; index < MAX_CODEX_TOKEN_USAGE_THREADS - 1; index++) {
      totals.record(`other-${index}`, index)
    }
    totals.record('child-1', 2)
    totals.record('newest', 3)
    expect(totals.get('child-1')).toBe(2)
    expect(totals.get('other-0')).toBeUndefined()
  })
})
