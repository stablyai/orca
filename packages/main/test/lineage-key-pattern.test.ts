import { describe, expect, it } from 'vitest'
import { extractKeysWithPattern } from '../../../src/main/lineage/lineage-key-extraction'

describe('extractKeysWithPattern', () => {
  it('extracts upper-cased keys after the :: prefix', () => {
    expect(
      extractKeysWithPattern('gnios::levgp-483 new loan', '[A-Za-z][A-Za-z0-9]{1,9}-\\d+')
    ).toEqual({
      keys: ['LEVGP-483']
    })
  })
  it('falls back to the default pattern and reports an invalid regex', () => {
    const result = extractKeysWithPattern('x::LEVGP-483', '([')
    expect(result.keys).toEqual(['LEVGP-483'])
    expect(result.error).toMatch(/invalid/i)
  })
  it('returns no keys when nothing matches', () => {
    expect(extractKeysWithPattern('plain name', 'ZZZ-\\d+')).toEqual({ keys: [] })
  })
  it('drops empty-string matches', () => {
    expect(extractKeysWithPattern('xyz', 'a*')).toEqual({ keys: [] })
  })
})
