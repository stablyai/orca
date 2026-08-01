import { describe, expect, it } from 'vitest'
import { CONTEXT_PRESSURE_COPY } from './context-pressure-copy'

describe('CONTEXT_PRESSURE_COPY', () => {
  it('covers every pressure level and limit source', () => {
    expect(Object.keys(CONTEXT_PRESSURE_COPY.levels)).toEqual(['ok', 'warning', 'critical'])
    expect(Object.keys(CONTEXT_PRESSURE_COPY.limitSources)).toEqual([
      'soft-cap',
      'model',
      'provider'
    ])
  })
})
