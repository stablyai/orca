import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import type * as GhosttyParser from './parser'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { statMock, readNodeFileWithinLimitMock, parseGhosttyConfigMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readNodeFileWithinLimitMock: vi.fn(),
  parseGhosttyConfigMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  stat: statMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof BoundedFileReader>()),
  readNodeFileWithinLimit: readNodeFileWithinLimitMock
}))

vi.mock('./parser', async (importOriginal) => {
  const actual = await importOriginal<typeof GhosttyParser>()
  parseGhosttyConfigMock.mockImplementation(actual.parseGhosttyConfig)
  return { ...actual, parseGhosttyConfig: parseGhosttyConfigMock }
})

vi.mock('os', () => ({
  platform: vi.fn(() => 'darwin'),
  homedir: vi.fn(() => '/Users/alice')
}))

import { NodeFileReadTooLargeError } from '../../shared/node-bounded-file-reader'
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

function fileRead(content: string, size = Buffer.byteLength(content)) {
  return {
    buffer: Buffer.from(content),
    stats: { isFile: () => true, size }
  }
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
    readNodeFileWithinLimitMock.mockResolvedValue(
      fileRead(`
font-family = JetBrains Mono
font-size = 14
background = #1a1a1a
`)
    )

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
    readNodeFileWithinLimitMock.mockImplementation(async (p: string) => {
      if (p === '/Users/alice/.config/ghostty/config.ghostty') {
        return fileRead('font-size = 22\nbackground = #1a1a1a\n')
      }
      if (p === '/Users/alice/.config/ghostty/config') {
        return fileRead('font-family = JetBrains Mono\nfont-size = 18\n')
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
    readNodeFileWithinLimitMock.mockResolvedValue(fileRead('font-family = Menlo\nfont-size = 12\n'))

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
    readNodeFileWithinLimitMock.mockResolvedValue(
      fileRead('background = #1a1a1a\nforeground = #e0e0e0\n')
    )

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
    readNodeFileWithinLimitMock.mockResolvedValue(
      fileRead('background = #1a1a1a\nforeground = #e0e0e0\n')
    )

    const result = await previewGhosttyImport(
      createStore({
        terminalColorOverrides: { foreground: '#e0e0e0', background: '#1a1a1a' }
      })
    )

    expect(result.found).toBe(true)
    expect(result.diff).toEqual({})
    expect(result.unsupportedKeys).toEqual([])
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
    readNodeFileWithinLimitMock.mockResolvedValue(fileRead('font-family = JetBrains Mono\n'))

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

  it('accepts a config at the exact byte limit', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath) {
        return { isFile: () => true, size: 1_000_000 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readNodeFileWithinLimitMock.mockResolvedValue(fileRead('font-size = 14\n', 1_000_000))

    const result = await previewGhosttyImport(createStore())

    expect(result.found).toBe(true)
    expect(result.diff).toEqual({ terminalFontSize: 14 })
    expect(readNodeFileWithinLimitMock).toHaveBeenCalledWith(configPath, 1_000_000)
  })

  it('rejects config growth beyond the limit before parsing', async () => {
    const configPath = '/Users/alice/Library/Application Support/com.mitchellh.ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === configPath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readNodeFileWithinLimitMock.mockRejectedValue(
      new NodeFileReadTooLargeError(1_000_001, 1_000_000)
    )

    const result = await previewGhosttyImport(createStore())

    expect(result).toMatchObject({
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: 'Config file is too large to import (1000001 bytes, limit 1000000).'
    })
    expect(parseGhosttyConfigMock).not.toHaveBeenCalled()
  })
})
