import { describe, expect, it } from 'vitest'

import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

describe('benchmark sample summary', () => {
  it('averages the two middle samples for an even-sized median', () => {
    expect(summarizeBenchmarkSamples([100, 1, 2, 99]).medianMs).toBe(50.5)
  })

  it('selects the middle sample for an odd-sized median', () => {
    expect(summarizeBenchmarkSamples([100, 1, 2, 99, 3]).medianMs).toBe(3)
  })

  it('preserves nearest-rank p95 and range reporting', () => {
    expect(summarizeBenchmarkSamples([1, 2, 3, 4, 5, 6])).toEqual({
      samples: 6,
      medianMs: 3.5,
      p95Ms: 6,
      minMs: 1,
      maxMs: 6
    })
  })

  it('rejects empty samples', () => {
    expect(() => summarizeBenchmarkSamples([])).toThrow('must not be empty')
  })
})
