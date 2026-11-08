import { describe, expect, it } from 'vitest'
import { assertSafeRemotePathSegment } from './ssh-remote-platform'

describe('assertSafeRemotePathSegment', () => {
  it.each(['.', '..', '../secret', 'child/name', 'nul\0byte'])(
    'rejects invalid segment %j under both path flavors',
    (segment) => {
      expect(() => assertSafeRemotePathSegment(segment, 'posix')).toThrow(
        'Unsafe remote path segment'
      )
      expect(() => assertSafeRemotePathSegment(segment, 'windows')).toThrow(
        'Unsafe remote path segment'
      )
    }
  )

  it('preserves valid POSIX names that Windows would reinterpret', () => {
    expect(() => assertSafeRemotePathSegment('notes\\2026\nfinal.txt', 'posix')).not.toThrow()
  })

  it.each([
    '..\\..\\.ssh\\orca_drop',
    'report.txt:orca',
    'question?.txt',
    'trailing.',
    'trailing ',
    'NUL',
    'con.txt',
    'CONIN$',
    'CLOCK$.log',
    'COM1.log',
    'LPT¹'
  ])('rejects Win32-special segment %j', (segment) => {
    expect(() => assertSafeRemotePathSegment(segment, 'windows')).toThrow(
      'Unsafe remote path segment'
    )
  })
})
