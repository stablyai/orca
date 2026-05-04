import path from 'path'
import { describe, expect, it, vi, afterEach } from 'vitest'

const { platformMock, homedirMock, statMock } = vi.hoisted(() => ({
  platformMock: vi.fn(),
  homedirMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('os', () => ({
  platform: platformMock,
  homedir: homedirMock
}))

vi.mock('fs/promises', () => ({
  stat: statMock
}))

import { findGhosttyConfigPath, getGhosttyConfigPaths } from './discovery'

function enoent(): Error {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
}

// Why: Capture original env values once so we can restore them after every test.
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalAppData = process.env.APPDATA

afterEach(() => {
  vi.clearAllMocks()
  if (originalXdgConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  } else {
    delete process.env.XDG_CONFIG_HOME
  }
  if (originalAppData !== undefined) {
    process.env.APPDATA = originalAppData
  } else {
    delete process.env.APPDATA
  }
})

describe('getGhosttyConfigPaths', () => {
  it('returns macOS paths with XDG precedence when XDG_CONFIG_HOME is not set', () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    const paths = getGhosttyConfigPaths()
    expect(paths).toEqual([
      '/Users/alice/.config/ghostty/config',
      '/Users/alice/.config/ghostty/config.ghostty',
      '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config',
      '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config.ghostty'
    ])
  })

  it('returns macOS paths with XDG_CONFIG_HOME override', () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    process.env.XDG_CONFIG_HOME = '/custom/xdg'

    const paths = getGhosttyConfigPaths()
    expect(paths).toEqual([
      '/custom/xdg/ghostty/config',
      '/custom/xdg/ghostty/config.ghostty',
      '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config',
      '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config.ghostty'
    ])
  })

  it('returns Linux paths with default XDG', () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    delete process.env.XDG_CONFIG_HOME

    const paths = getGhosttyConfigPaths()
    expect(paths).toEqual([
      '/home/bob/.config/ghostty/config',
      '/home/bob/.config/ghostty/config.ghostty'
    ])
  })

  it('returns Linux paths with XDG_CONFIG_HOME override', () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    process.env.XDG_CONFIG_HOME = '/custom/config'

    const paths = getGhosttyConfigPaths()
    expect(paths).toEqual([
      '/custom/config/ghostty/config',
      '/custom/config/ghostty/config.ghostty'
    ])
  })

  it('returns Windows paths', () => {
    homedirMock.mockReturnValue('C:\\Users\\Charlie')
    platformMock.mockReturnValue('win32')
    process.env.APPDATA = 'C:\\Users\\Charlie\\AppData\\Roaming'

    const paths = getGhosttyConfigPaths()
    expect(paths).toEqual([
      path.win32.join('C:\\Users\\Charlie\\AppData\\Roaming', 'ghostty', 'config'),
      path.win32.join('C:\\Users\\Charlie\\AppData\\Roaming', 'ghostty', 'config.ghostty')
    ])
  })

  it('returns empty array for unsupported platforms', () => {
    platformMock.mockReturnValue('freebsd')
    expect(getGhosttyConfigPaths()).toEqual([])
  })
})

describe('findGhosttyConfigPath', () => {
  it('returns macOS XDG path when file exists', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/config') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/Users/alice/.config/ghostty/config')
  })

  it('prefers macOS XDG path over Application Support when both exist', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (
        p === '/Users/alice/.config/ghostty/config' ||
        p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
      ) {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/Users/alice/.config/ghostty/config')
  })

  it('returns macOS app-support path when XDG files are missing', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/Users/alice/Library/Application Support/com.mitchellh.ghostty/config')
  })

  it('returns macOS config.ghostty fallback when config is missing', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/config.ghostty') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/Users/alice/.config/ghostty/config.ghostty')
  })

  it('prefers config over config.ghostty when both exist in the same directory', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (
        p === '/Users/alice/.config/ghostty/config' ||
        p === '/Users/alice/.config/ghostty/config.ghostty'
      ) {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/Users/alice/.config/ghostty/config')
  })

  it('returns null when no config exists on macOS', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    statMock.mockRejectedValue(enoent())

    const result = await findGhosttyConfigPath()
    expect(result).toBeNull()
  })

  it('returns Linux path when file exists', async () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (p === '/home/bob/.config/ghostty/config') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/home/bob/.config/ghostty/config')
  })

  it('returns Linux config.ghostty fallback when config is missing', async () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    delete process.env.XDG_CONFIG_HOME

    statMock.mockImplementation(async (p: string) => {
      if (p === '/home/bob/.config/ghostty/config.ghostty') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/home/bob/.config/ghostty/config.ghostty')
  })

  it('returns Linux XDG_CONFIG_HOME override path when set', async () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    process.env.XDG_CONFIG_HOME = '/custom/config'

    statMock.mockImplementation(async (p: string) => {
      if (p === '/custom/config/ghostty/config') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/custom/config/ghostty/config')
  })

  it('returns macOS XDG_CONFIG_HOME override path when file exists', async () => {
    homedirMock.mockReturnValue('/Users/alice')
    platformMock.mockReturnValue('darwin')
    process.env.XDG_CONFIG_HOME = '/custom/xdg'

    statMock.mockImplementation(async (p: string) => {
      if (p === '/custom/xdg/ghostty/config') {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe('/custom/xdg/ghostty/config')
  })

  it('returns null when no config exists on Linux', async () => {
    homedirMock.mockReturnValue('/home/bob')
    platformMock.mockReturnValue('linux')
    statMock.mockRejectedValue(enoent())

    const result = await findGhosttyConfigPath()
    expect(result).toBeNull()
  })

  it('returns Windows path when file exists', async () => {
    homedirMock.mockReturnValue('C:\\Users\\Charlie')
    platformMock.mockReturnValue('win32')
    process.env.APPDATA = 'C:\\Users\\Charlie\\AppData\\Roaming'
    const expectedPath = path.win32.join(
      'C:\\Users\\Charlie\\AppData\\Roaming',
      'ghostty',
      'config'
    )

    statMock.mockImplementation(async (p: string) => {
      if (p === expectedPath) {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe(expectedPath)
  })

  it('returns Windows config.ghostty fallback when config is missing', async () => {
    homedirMock.mockReturnValue('C:\\Users\\Charlie')
    platformMock.mockReturnValue('win32')
    process.env.APPDATA = 'C:\\Users\\Charlie\\AppData\\Roaming'
    const expectedPath = path.win32.join(
      'C:\\Users\\Charlie\\AppData\\Roaming',
      'ghostty',
      'config.ghostty'
    )

    statMock.mockImplementation(async (p: string) => {
      if (p === expectedPath) {
        return { isFile: () => true }
      }
      throw enoent()
    })

    const result = await findGhosttyConfigPath()
    expect(result).toBe(expectedPath)
  })

  it('returns null for unsupported platforms', async () => {
    platformMock.mockReturnValue('freebsd')
    const result = await findGhosttyConfigPath()
    expect(result).toBeNull()
  })
})
