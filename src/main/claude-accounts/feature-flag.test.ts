import { describe, expect, it } from 'vitest'
import { isMultiProviderEnabled } from './feature-flag'

describe('isMultiProviderEnabled', () => {
  it('returns false when settings flag is unset (default)', () => {
    expect(isMultiProviderEnabled({ claudeMultiProviderEnabled: undefined })).toBe(false)
  })

  it('returns true when settings flag is explicitly true', () => {
    expect(isMultiProviderEnabled({ claudeMultiProviderEnabled: true })).toBe(true)
  })

  it('returns false when settings flag is false', () => {
    expect(isMultiProviderEnabled({ claudeMultiProviderEnabled: false })).toBe(false)
  })
})
