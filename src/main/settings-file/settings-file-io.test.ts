import { describe, expect, it } from 'vitest'
import { isTransientWriteFailure } from './settings-file-io'

function errnoError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

describe('settings file write failure classification', () => {
  it('treats EPERM and EBUSY as transient only on Windows', () => {
    expect(isTransientWriteFailure(errnoError('EPERM'), 'win32')).toBe(true)
    expect(isTransientWriteFailure(errnoError('EBUSY'), 'win32')).toBe(true)
    expect(isTransientWriteFailure(errnoError('EPERM'), 'darwin')).toBe(false)
    expect(isTransientWriteFailure(errnoError('EBUSY'), 'linux')).toBe(false)
  })

  it('does not treat permission failures as transient on Windows', () => {
    expect(isTransientWriteFailure(errnoError('EACCES'), 'win32')).toBe(false)
    expect(isTransientWriteFailure(new Error('boom'), 'win32')).toBe(false)
  })
})
