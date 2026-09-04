import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, readFileMock, showOpenDialogMock, fromWebContentsMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  showOpenDialogMock: vi.fn(),
  fromWebContentsMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock },
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

const DISCOVERED_CONFIG_PATH = '/Users/alice/.config/ghostty/config'
const PICKED_CONFIG_PATH = '/Users/alice/Documents/ghostty-backup/config'
const CONFIG_CONTENT = `
font-family = JetBrains Mono
font-size = 15
background = #1a1a1a
mouse-hide-while-typing = true
`

const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

beforeEach(() => {
  delete process.env.XDG_CONFIG_HOME
})

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

function mockReadableFiles(files: Record<string, { content: string; size?: number }>): void {
  statMock.mockImplementation(async (filePath: string) => {
    const file = files[filePath]
    if (!file) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return { isFile: () => true, size: file.size ?? file.content.length }
  })
  readFileMock.mockImplementation(async (filePath: string) => {
    const file = files[filePath]
    if (!file) {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    return file.content
  })
}

describe('previewGhosttyImport manual config file', () => {
  it('falls back to auto discovery when no source is given', async () => {
    mockReadableFiles({ [DISCOVERED_CONFIG_PATH]: { content: CONFIG_CONTENT } })

    const result = await previewGhosttyImport(createStore())

    expect(showOpenDialogMock).not.toHaveBeenCalled()
    expect(result.found).toBe(true)
    expect(result.configPaths).toEqual([DISCOVERED_CONFIG_PATH])
  })

  it('rejects an invalid source without discovering or prompting', async () => {
    const surprise = await previewGhosttyImport(createStore(), { kind: 'chooseFolder' })
    const nullSource = await previewGhosttyImport(createStore(), null)
    const extraField = await previewGhosttyImport(createStore(), {
      kind: 'chooseFile',
      path: '/Users/alice/.config/ghostty/config'
    })

    expect(surprise).toEqual({
      found: false,
      diff: {},
      unsupportedKeys: [],
      error: 'Invalid Ghostty import source.'
    })
    expect(nullSource.error).toBe('Invalid Ghostty import source.')
    expect(extraField.error).toBe('Invalid Ghostty import source.')
    expect(statMock).not.toHaveBeenCalled()
    expect(showOpenDialogMock).not.toHaveBeenCalled()
  })

  it('marks a dismissed file picker as canceled without touching settings', async () => {
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const result = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(result).toEqual({ found: false, canceled: true, diff: {}, unsupportedKeys: [] })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('treats an empty file-picker selection as canceled', async () => {
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [] })

    const result = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(result).toEqual({ found: false, canceled: true, diff: {}, unsupportedKeys: [] })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('refuses a picked config above the import size limit', async () => {
    mockReadableFiles({
      [PICKED_CONFIG_PATH]: { content: CONFIG_CONTENT, size: 1_000_001 }
    })
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [PICKED_CONFIG_PATH] })

    const result = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(result.found).toBe(false)
    expect(result.canceled).toBeUndefined()
    expect(result.error).toBe('Config file is too large to import (1000001 bytes, limit 1000000).')
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('reports a picked config that cannot be read', async () => {
    mockReadableFiles({})
    statMock.mockResolvedValue({ isFile: () => true, size: 128 })
    readFileMock.mockRejectedValue(new Error('EACCES: permission denied'))
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [PICKED_CONFIG_PATH] })

    const result = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(result.found).toBe(false)
    expect(result.error).toBe('Could not read config: EACCES: permission denied')
  })

  it('produces the same preview from a picked file as from auto discovery', async () => {
    const settings = { terminalFontFamily: 'Menlo', terminalFontSize: 12 }
    mockReadableFiles({ [DISCOVERED_CONFIG_PATH]: { content: CONFIG_CONTENT } })
    const discovered = await previewGhosttyImport(createStore(settings), { kind: 'auto' })

    vi.clearAllMocks()
    mockReadableFiles({ [PICKED_CONFIG_PATH]: { content: CONFIG_CONTENT } })
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [PICKED_CONFIG_PATH] })
    const picked = await previewGhosttyImport(createStore(settings), { kind: 'chooseFile' })

    expect(discovered.found).toBe(true)
    expect(picked.found).toBe(true)
    expect(picked.diff).toEqual(discovered.diff)
    expect(picked.unsupportedKeys).toEqual(discovered.unsupportedKeys)
    expect(picked.configPath).toBe(PICKED_CONFIG_PATH)
    expect(picked.configPaths).toEqual([PICKED_CONFIG_PATH])
  })

  it('reads only the picked file, ignoring the discovered config paths', async () => {
    mockReadableFiles({
      [DISCOVERED_CONFIG_PATH]: { content: 'font-size = 30\n' },
      [PICKED_CONFIG_PATH]: { content: CONFIG_CONTENT }
    })
    showOpenDialogMock.mockResolvedValueOnce({ canceled: false, filePaths: [PICKED_CONFIG_PATH] })

    const result = await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(result.configPaths).toEqual([PICKED_CONFIG_PATH])
    expect(result.diff.terminalFontSize).toBe(15)
    expect(readFileMock).not.toHaveBeenCalledWith(DISCOVERED_CONFIG_PATH, 'utf-8')
  })

  it('anchors the picker to the requesting window when one is resolvable', async () => {
    const ownerWindow = { id: 1 }
    fromWebContentsMock.mockReturnValue(ownerWindow)
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    const webContents = { id: 42 } as never

    await previewGhosttyImport(createStore(), { kind: 'chooseFile' }, webContents)

    expect(fromWebContentsMock).toHaveBeenCalledWith(webContents)
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      ownerWindow,
      expect.objectContaining({ properties: ['openFile'] })
    )
  })

  it('opens a window-less picker when no web contents is given', async () => {
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    await previewGhosttyImport(createStore(), { kind: 'chooseFile' })

    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(showOpenDialogMock).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile'] })
    )
  })
})
