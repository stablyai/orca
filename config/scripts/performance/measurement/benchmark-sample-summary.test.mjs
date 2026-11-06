import { describe, expect, it } from 'vitest'

import { summarizeBenchmarkSamples } from './benchmark-sample-summary.mjs'

describe('benchmark sample summary', () => {
  it('averages the two middle samples for an even-sized median', () => {
    expect(summarizeBenchmarkSamples([100, 1, 2, 99]).medianMs).toBe(50.5)
  })
})
