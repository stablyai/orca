import { describe, expect, it } from 'vitest'
import { resolvePickerDefaultPath } from './repos-pick-default-path'

describe('resolvePickerDefaultPath', () => {
  it('returns the provided path', () => {
    expect(resolvePickerDefaultPath('/projects')).toBe('/projects')
  })

  it('trims surrounding whitespace', () => {
    expect(resolvePickerDefaultPath('  /projects  ')).toBe('/projects')
  })

  it('returns undefined when absent', () => {
    expect(resolvePickerDefaultPath(undefined)).toBeUndefined()
  })

  it('treats whitespace as unset', () => {
    expect(resolvePickerDefaultPath('  ')).toBeUndefined()
  })
})
