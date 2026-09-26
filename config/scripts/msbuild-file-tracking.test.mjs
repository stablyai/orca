import { describe, expect, it } from 'vitest'
import { disableMsbuildFileTrackingOnWindows } from './msbuild-file-tracking.mjs'

describe('disableMsbuildFileTrackingOnWindows', () => {
  it('turns tracking off on Windows when the caller left it unset', () => {
    expect(disableMsbuildFileTrackingOnWindows({ PATH: 'x' }, 'win32')).toEqual({
      PATH: 'x',
      TrackFileAccess: 'false'
    })
  })

  it('keeps a caller-set value', () => {
    expect(disableMsbuildFileTrackingOnWindows({ TrackFileAccess: 'true' }, 'win32')).toEqual({
      TrackFileAccess: 'true'
    })
  })

  it('keeps a caller-set value whatever its casing', () => {
    expect(disableMsbuildFileTrackingOnWindows({ trackfileaccess: 'true' }, 'win32')).toEqual({
      trackfileaccess: 'true'
    })
  })

  it('leaves non-Windows hosts alone', () => {
    expect(disableMsbuildFileTrackingOnWindows({}, 'linux')).toEqual({})
  })
})
