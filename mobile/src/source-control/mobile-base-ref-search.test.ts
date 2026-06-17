import { describe, expect, it } from 'vitest'
import { mapBaseRefResults } from './mobile-base-ref-search'

describe('mapBaseRefResults', () => {
  it('extracts a clean string list from a well-formed payload', () => {
    expect(mapBaseRefResults({ refs: ['main', 'dev'] })).toEqual(['main', 'dev'])
  })

  it('returns [] for malformed payloads and drops bad entries', () => {
    expect(mapBaseRefResults(null)).toEqual([])
    expect(mapBaseRefResults({})).toEqual([])
    expect(mapBaseRefResults({ refs: 'x' })).toEqual([])
    expect(mapBaseRefResults({ refs: ['ok', 2, '', null, 'two'] })).toEqual(['ok', 'two'])
  })
})
