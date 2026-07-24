import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
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

import { previewGhosttyImport } from './index'

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

function createStore(settings: Record<string, unknown> = {}): Store {
  return {
    getSettings: () => settings as GlobalSettings
  } as Store
}

describe('previewGhosttyImport theme references', () => {
  it('resolves a theme reference into color overrides', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    const themePath = '/Users/alice/.config/ghostty/themes/Tomorrow Night Bright'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath || p === themePath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockImplementation(async (p: string) => {
      if (p === themePath) {
        return 'palette = 1=#d54e53\nbackground = #000000\nforeground = #eaeaea\n'
      }
      return 'theme = Tomorrow Night Bright\nfont-size = 14\n'
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toEqual({
      terminalFontSize: 14,
      terminalColorOverrides: {
        red: '#d54e53',
        background: '#000000',
        foreground: '#eaeaea'
      }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('lets explicit config colors override theme colors', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    const themePath = '/Users/alice/.config/ghostty/themes/night'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath || p === themePath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockImplementation(async (p: string) => {
      if (p === themePath) {
        return 'palette = 1=#d54e53\npalette = 2=#b9ca4a\nbackground = #000000\n'
      }
      return 'theme = night\nbackground = #101010\npalette = 1=#ff0000\n'
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toEqual({
      terminalColorOverrides: {
        // Why: config's palette index 1 and background win; theme keeps index 2.
        red: '#ff0000',
        green: '#b9ca4a',
        background: '#101010'
      }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('resolves an absolute theme path without probing theme search dirs', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    const themePath = '/Users/alice/themes/work'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath || p === themePath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockImplementation(async (p: string) => {
      if (p === themePath) {
        return 'background = #202020\nforeground = #f0f0f0\n'
      }
      return `theme = ${themePath}\n`
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toEqual({
      terminalColorOverrides: {
        background: '#202020',
        foreground: '#f0f0f0'
      }
    })
    expect(statMock).toHaveBeenCalledWith(themePath)
    expect(statMock).not.toHaveBeenCalledWith(
      '/Users/alice/.config/ghostty/themes/Users/alice/themes/work'
    )
    expect(result.unsupportedKeys).toEqual([])
  })

  it('marks an unresolvable theme as unsupported', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('theme = Missing Theme\n')

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['theme (theme file not found)'])
  })

  it('marks light:/dark: theme pairs as unsupported', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('theme = light:Tomorrow,dark:Tomorrow Night\n')

    const result = await previewGhosttyImport(createStore())

    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual(['theme (light:/dark: pairs not supported)'])
  })
})
