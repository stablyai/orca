import { describe, expect, it } from 'vitest'
import { resolvePickerDefaultPath } from './repos-pick-default-path'

describe('resolvePickerDefaultPath', () => {
  it('uses the explicit arg when provided', () => {
    expect(resolvePickerDefaultPath('/arg/path', '/setting/path')).toBe('/arg/path')
  })

  it('falls back to the saved setting when no arg', () => {
    expect(resolvePickerDefaultPath(undefined, '/setting/path')).toBe('/setting/path')
  })

  it('returns undefined when neither is set (preserves OS default)', () => {
    expect(resolvePickerDefaultPath(undefined, undefined)).toBeUndefined()
  })

  it('treats an empty saved setting as unset', () => {
    expect(resolvePickerDefaultPath(undefined, '')).toBeUndefined()
  })
})
