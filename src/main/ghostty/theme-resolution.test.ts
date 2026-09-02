import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  stat: statMock,
  readFile: readFileMock
}))

vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
  homedir: vi.fn(() => '/Users/alice')
}))

import { getGhosttyThemeSearchDirs, resolveGhosttyThemeColors } from './theme-resolution'

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
const originalGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR

beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME
  delete process.env.GHOSTTY_RESOURCES_DIR
})

afterEach(() => {
  vi.clearAllMocks()
  if (originalXdgConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  } else {
    delete process.env.XDG_CONFIG_HOME
  }
  if (originalGhosttyResourcesDir !== undefined) {
    process.env.GHOSTTY_RESOURCES_DIR = originalGhosttyResourcesDir
  } else {
    delete process.env.GHOSTTY_RESOURCES_DIR
  }
})

const THEME_FILE = `
palette = 0=#000000
palette = 1=#d54e53
background = #000000
foreground = #eaeaea
cursor-color = #eaeaea
selection-background = #424242
selection-foreground = #eaeaea
`

describe('getGhosttyThemeSearchDirs', () => {
  it('probes XDG, then the Ghostty.app resources dir', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(getGhosttyThemeSearchDirs()).toEqual([
      '/Users/alice/.config/ghostty/themes',
      '/Applications/Ghostty.app/Contents/Resources/ghostty/themes'
    ])
  })

  it('honors XDG_CONFIG_HOME for the custom themes dir', () => {
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getGhosttyThemeSearchDirs()[0]).toBe('/xdg/ghostty/themes')
  })

  it('honors GHOSTTY_RESOURCES_DIR for bundled themes', () => {
    process.env.GHOSTTY_RESOURCES_DIR = '/opt/ghostty'
    expect(getGhosttyThemeSearchDirs()).toEqual([
      '/Users/alice/.config/ghostty/themes',
      '/opt/ghostty/themes'
    ])
  })
})

describe('resolveGhosttyThemeColors', () => {
  it('reads the first matching theme file and returns only color keys', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/themes/Tomorrow Night Bright') {
        return { isFile: () => true, size: THEME_FILE.length }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue(THEME_FILE)

    const result = await resolveGhosttyThemeColors('Tomorrow Night Bright')
    expect(result).toEqual({
      palette: ['0=#000000', '1=#d54e53'],
      background: '#000000',
      foreground: '#eaeaea',
      'cursor-color': '#eaeaea',
      'selection-background': '#424242',
      'selection-foreground': '#eaeaea'
    })
  })

  it('falls through to later dirs when earlier ones miss', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Applications/Ghostty.app/Contents/Resources/ghostty/themes/Tomorrow') {
        return { isFile: () => true, size: THEME_FILE.length }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('background = #1d1f21')

    const result = await resolveGhosttyThemeColors('Tomorrow')
    expect(result).toEqual({ background: '#1d1f21' })
  })

  it('resolves absolute theme paths without searching named theme dirs', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/themes/work') {
        return { isFile: () => true, size: 64 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('background = #1d1f21')

    const result = await resolveGhosttyThemeColors('/Users/alice/themes/work')
    expect(result).toEqual({ background: '#1d1f21' })
    expect(statMock).toHaveBeenCalledTimes(1)
  })

  it('drops non-color keys a theme file might carry', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/themes/custom') {
        return { isFile: () => true, size: 64 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('background = #101010\nfont-size = 20')

    const result = await resolveGhosttyThemeColors('custom')
    expect(result).toEqual({ background: '#101010' })
  })

  it('returns null when the theme is not found anywhere', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    expect(await resolveGhosttyThemeColors('Missing Theme')).toBeNull()
  })

  it('rejects names containing path separators or traversal', async () => {
    expect(await resolveGhosttyThemeColors('../etc/passwd')).toBeNull()
    expect(await resolveGhosttyThemeColors('a/b')).toBeNull()
    expect(await resolveGhosttyThemeColors('a\\b')).toBeNull()
    expect(await resolveGhosttyThemeColors('..')).toBeNull()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('rejects oversized theme files', async () => {
    statMock.mockImplementation(async () => ({ isFile: () => true, size: 10_000_000 }))
    expect(await resolveGhosttyThemeColors('huge')).toBeNull()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledTimes(1)
  })

  it('does not fall through when a shadowing theme path is invalid', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/themes/night') {
        return { isFile: () => false, size: 128 }
      }
      if (p === '/Applications/Ghostty.app/Contents/Resources/ghostty/themes/night') {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    expect(await resolveGhosttyThemeColors('night')).toBeNull()
    expect(readFileMock).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledTimes(1)
  })
})
