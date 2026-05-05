import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import { describe, expect, it, vi } from 'vitest'

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
