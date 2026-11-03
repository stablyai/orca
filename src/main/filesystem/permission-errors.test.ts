import { describe, expect, it } from 'vitest'
import { isPermissionError } from './permission-errors'

describe('isPermissionError', () => {
  it('returns true for EPERM and EACCES Node errors', () => {
    const eperm = Object.assign(new Error('denied'), { code: 'EPERM' })
    const eacces = Object.assign(new Error('denied'), { code: 'EACCES' })
    expect(isPermissionError(eperm)).toBe(true)
    expect(isPermissionError(eacces)).toBe(true)
  })

  it('returns false for unrelated errors and non-error values', () => {
    expect(isPermissionError(Object.assign(new Error('nope'), { code: 'ENOENT' }))).toBe(false)
    expect(isPermissionError(new Error('plain'))).toBe(false)
    expect(isPermissionError(null)).toBe(false)
    expect(isPermissionError('EPERM')).toBe(false)
  })
})
