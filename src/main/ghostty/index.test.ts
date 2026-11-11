import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock, showOpenDialogMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn(() => null) },
  dialog: { showOpenDialog: showOpenDialogMock }
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
  it('reads only the picked file and never a renderer-supplied path', async () => {
    const pickedPath = '/Users/alice/dotfiles/ghostty/config'
    statMock.mockResolvedValue({ isFile: () => true, size: 32 })
    readFileMock.mockResolvedValue('font-size = 15\n')
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [pickedPath] })

    const picked = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })
    expect(picked.configPaths).toEqual([pickedPath])
    expect(picked.diff.terminalFontSize).toBe(15)
    expect(readFileMock).toHaveBeenCalledTimes(1)

    const withPath = await previewGhosttyImport(createStore(), {
      kind: 'chooseFile',
      path: '/etc/passwd'
    })
    expect(withPath.error).toBe('Invalid Ghostty import source.')

    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const canceled = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })
    expect(canceled).toEqual({ found: false, canceled: true, diff: {}, unsupportedKeys: [] })
    expect(readFileMock).toHaveBeenCalledTimes(1)
  })

  it('keeps successfully imported settings when a later config cannot be read', async () => {
    delete process.env.XDG_CONFIG_HOME
    const firstPath = '/Users/alice/.config/ghostty/config.ghostty'
    const unreadablePath = '/Users/alice/.config/ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === firstPath || p === unreadablePath) {
        return { isFile: () => true, size: 128 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockImplementation(async (p: string) => {
      if (p === firstPath) {
        return 'font-size = 22\n'
      }
      throw new Error('EACCES')
    })

    const result = await previewGhosttyImport(createStore())

    expect(result).toMatchObject({
      found: true,
      configPath: firstPath,
      configPaths: [firstPath],
      diff: { terminalFontSize: 22 }
    })
  })

  it('keeps successfully imported settings when a later config is too large', async () => {
    delete process.env.XDG_CONFIG_HOME
    const firstPath = '/Users/alice/.config/ghostty/config.ghostty'
    const oversizedPath = '/Users/alice/.config/ghostty/config'
    statMock.mockImplementation(async (p: string) => {
      if (p === firstPath) {
        return { isFile: () => true, size: 128 }
      }
      if (p === oversizedPath) {
        return { isFile: () => true, size: 1_000_001 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    readFileMock.mockResolvedValue('font-size = 22\n')

    const result = await previewGhosttyImport(createStore())

    expect(result).toMatchObject({
      found: true,
      configPath: firstPath,
      configPaths: [firstPath],
      diff: { terminalFontSize: 22 }
    })
    expect(readFileMock).not.toHaveBeenCalledWith(oversizedPath, 'utf-8')
  })
})
