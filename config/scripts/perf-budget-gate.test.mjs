import { describe, expect, it } from 'vitest'

import { collectBudgetViolations } from './perf-budget-gate.mjs'

const MS = (max, required = false) => ({ max, unit: 'ms', required })

describe('collectBudgetViolations', () => {
  it('passes a metric under budget', () => {
    const { violations } = collectBudgetViolations({ a: 100 }, { a: MS(200) })
    expect(violations).toEqual([])
  })

  it('passes a metric exactly at budget', () => {
    const { violations } = collectBudgetViolations({ a: 200 }, { a: MS(200) })
    expect(violations).toEqual([])
  })

  it('fails a metric over budget and formats both sides', () => {
    const { violations } = collectBudgetViolations({ a: 201 }, { a: MS(200) })
    expect(violations).toEqual(['a: 201ms exceeded budget 200ms'])
  })

  it('fails when a required metric is missing, so a renamed phase cannot mute the gate', () => {
    const { violations } = collectBudgetViolations({}, { a: MS(200, true) })
    expect(violations).toEqual(['a: required metric missing from report'])
  })

  it('skips an optional metric that was not observed', () => {
    const { violations, rows } = collectBudgetViolations({}, { a: MS(200, false) })
    expect(violations).toEqual([])
    expect(rows).toEqual([{ metric: 'a', value: null, spec: MS(200, false) }])
  })

  it('treats an explicit null as not observed rather than as zero', () => {
    const { violations } = collectBudgetViolations({ a: null }, { a: MS(200, false) })
    expect(violations).toEqual([])
  })

  it('fails a non-numeric value instead of coercing it', () => {
    const { violations } = collectBudgetViolations({ a: 'fast' }, { a: MS(200) })
    expect(violations).toEqual(['a: value "fast" is not a finite number'])
  })

  it('fails a NaN value', () => {
    const { violations } = collectBudgetViolations({ a: Number.NaN }, { a: MS(200) })
    expect(violations.length).toBe(1)
  })

  it('enforces a zero budget for structural counts', () => {
    expect(
      collectBudgetViolations({ leaked: 0 }, { leaked: { max: 0, unit: 'count' } }).violations
    ).toEqual([])
    expect(
      collectBudgetViolations({ leaked: 1 }, { leaked: { max: 0, unit: 'count' } }).violations
    ).toEqual(['leaked: 1 exceeded budget 0'])
  })

  it('formats percent and byte units for readability', () => {
    expect(
      collectBudgetViolations({ cpu: 61.25 }, { cpu: { max: 60, unit: '%' } }).violations
    ).toEqual(['cpu: 61.3% exceeded budget 60.0%'])
    expect(
      collectBudgetViolations({ rss: 2_500_000_000 }, { rss: { max: 2_000_000_000, unit: 'bytes' } })
        .violations
    ).toEqual(['rss: 2500MB exceeded budget 2000MB'])
  })

  it('reports every violation, not just the first', () => {
    const { violations } = collectBudgetViolations(
      { a: 999, b: 999 },
      { a: MS(1), b: MS(1), c: MS(1, true) }
    )
    expect(violations.length).toBe(3)
  })
})
