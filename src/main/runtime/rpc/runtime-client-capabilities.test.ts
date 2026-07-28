import { describe, expect, it } from 'vitest'
import { parseRuntimeClientCapabilities } from './runtime-client-capabilities'

describe('parseRuntimeClientCapabilities', () => {
  it('accepts a bounded string array', () => {
    expect(parseRuntimeClientCapabilities(['session-tabs.close-intent.v1', 'future.v1'])).toEqual([
      'session-tabs.close-intent.v1',
      'future.v1'
    ])
  })

  it.each([
    undefined,
    'session-tabs.close-intent.v1',
    [7],
    [''],
    ['x'.repeat(129)],
    Array.from({ length: 65 }, () => 'future.v1')
  ])('rejects malformed or oversized capability input', (value) => {
    expect(parseRuntimeClientCapabilities(value)).toEqual([])
  })
})
