import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

afterEach(() => {
  vi.clearAllMocks()
  if (originalXdgConfigHome !== undefined) {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  } else {
    delete process.env.XDG_CONFIG_HOME
  }
})

function createStore(settings: Record<string, unknown> = {}): Store {
  return {
    getSettings: () => settings as GlobalSettings
  } as Store
}

describe('previewGhosttyImport', () => {
  it('returns found false when no config exists', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const result = await previewGhosttyImport(createStore())
    expect(result.found).toBe(false)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([])
  })

  it('returns diff and unsupported keys when config exists', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue(`
font-family = JetBrains Mono
font-size = 14
background = #1a1a1a
`)

    const result = await previewGhosttyImport(
      createStore({
        terminalFontFamily: 'Menlo',
        terminalFontSize: 12
      })
    )

    expect(result.found).toBe(true)
    expect(result.configPath).toBe(
      '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    )
    expect(result.diff).toEqual({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 14,
      terminalColorOverrides: { background: '#1a1a1a' }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('imports every discovered config file in Ghostty load order', async () => {
    delete process.env.XDG_CONFIG_HOME
    statMock.mockImplementation(async (p: string) => {
      if (
        p === '/Users/alice/.config/ghostty/config.ghostty' ||
        p === '/Users/alice/.config/ghostty/config'
      ) {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/config.ghostty') {
        return 'font-size = 22\nbackground = #1a1a1a\n'
      }
      if (p === '/Users/alice/.config/ghostty/config') {
        return 'font-family = JetBrains Mono\nfont-size = 18\n'
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    const result = await previewGhosttyImport(createStore())

    expect(result.found).toBe(true)
    expect(result.configPath).toBe('/Users/alice/.config/ghostty/config.ghostty')
    expect(result.configPaths).toEqual([
      '/Users/alice/.config/ghostty/config.ghostty',
      '/Users/alice/.config/ghostty/config'
    ])
    expect(result.diff).toEqual({
      terminalFontFamily: 'JetBrains Mono',
      terminalFontSize: 18,
      terminalColorOverrides: { background: '#1a1a1a' }
    })
    expect(result.unsupportedKeys).toEqual([])
  })

  it('omits values that match current settings', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('font-family = Menlo\nfont-size = 12\n')

    const result = await previewGhosttyImport(
      createStore({
        terminalFontFamily: 'Menlo',
        terminalFontSize: 12
      })
    )

    expect(result.found).toBe(true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([])
  })

  it('omits object values that are deeply equal to current settings', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('background = #1a1a1a\nforeground = #e0e0e0\n')

    const result = await previewGhosttyImport(
      createStore({
        terminalColorOverrides: { background: '#1a1a1a', foreground: '#e0e0e0' }
      })
    )

    expect(result.found).toBe(true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([])
  })

  it('omits object values that are equal regardless of key order', async () => {
    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('background = #1a1a1a\nforeground = #e0e0e0\n')

    const result = await previewGhosttyImport(
      createStore({
        terminalColorOverrides: { foreground: '#e0e0e0', background: '#1a1a1a' }
      })
    )

    expect(result.found).toBe(true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([])
  })

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

  it('does not set up file watchers or timers (no live sync)', async () => {
    const watchMock = vi.fn()
    const watchFileMock = vi.fn()
    const setIntervalMock = vi.fn()
    const setTimeoutMock = vi.fn()

    vi.doMock('fs', () => ({
      watch: watchMock,
      watchFile: watchFileMock
    }))

    statMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config') {
        return { isFile: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('font-family = JetBrains Mono\n')

    // Why: Replace timer globals temporarily to detect any polling setup.
    const originalSetInterval = globalThis.setInterval
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setInterval = setIntervalMock as unknown as typeof setInterval
    globalThis.setTimeout = setTimeoutMock as unknown as typeof setTimeout

    try {
      await previewGhosttyImport(createStore())
    } finally {
      globalThis.setInterval = originalSetInterval
      globalThis.setTimeout = originalSetTimeout
    }

    expect(watchMock).not.toHaveBeenCalled()
    expect(watchFileMock).not.toHaveBeenCalled()
    expect(setIntervalMock).not.toHaveBeenCalled()
    expect(setTimeoutMock).not.toHaveBeenCalled()
  })
})
