import { beforeEach, describe, expect, it, vi } from 'vitest'

const platformMock = vi.hoisted(() => vi.fn())
const homedirMock = vi.hoisted(() => vi.fn(() => '/Users/alice'))

vi.mock('os', () => ({
  homedir: homedirMock,
  platform: platformMock
}))

import { getWarpThemeDirectories } from './discovery'

describe('getWarpThemeDirectories', () => {
  beforeEach(() => {
    vi.unstubAllEnvs()
    platformMock.mockReset()
    homedirMock.mockReturnValue('/Users/alice')
  })

  it('returns the macOS Warp theme directory', () => {
    platformMock.mockReturnValue('darwin')
    expect(getWarpThemeDirectories()).toEqual(['/Users/alice/.warp/themes'])
  })

  it('returns the Linux XDG data theme directory', () => {
    platformMock.mockReturnValue('linux')
    vi.stubEnv('XDG_DATA_HOME', '/data/alice')
    expect(getWarpThemeDirectories()).toEqual(['/data/alice/warp-terminal/themes'])
  })

  it('returns the Windows app data theme directory with Windows separators', () => {
    platformMock.mockReturnValue('win32')
    homedirMock.mockReturnValue('C:\\Users\\alice')
    vi.stubEnv('APPDATA', 'C:\\Users\\alice\\AppData\\Roaming')
    expect(getWarpThemeDirectories()).toEqual([
      'C:\\Users\\alice\\AppData\\Roaming\\warp\\Warp\\data\\themes'
    ])
  })
})
