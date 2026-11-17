import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'

const readFileMock = vi.hoisted(() => vi.fn())
const statMock = vi.hoisted(() => vi.fn())
const parseWarpThemeYamlWithTimeoutMock = vi.hoisted(() => vi.fn())
const showOpenDialogMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: showOpenDialogMock }
}))

vi.mock('fs/promises', () => ({
  opendir: vi.fn(),
  readFile: readFileMock,
  realpath: vi.fn(),
  stat: statMock
}))

vi.mock('./parser-runner', () => ({
  parseWarpThemeYamlWithTimeout: parseWarpThemeYamlWithTimeoutMock
}))

import { previewWarpThemeImport } from './index'
import { parseWarpThemeYaml } from './parser'
import type { Store } from '../persistence/loading-store/store'

const VALID_THEME = `
name: Duplicate
background: '#111111'
foreground: '#eeeeee'
terminal_colors:
  normal:
    black: '#000000'
`

describe('previewWarpThemeImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    statMock.mockResolvedValue({ isFile: () => true, size: VALID_THEME.length })
    parseWarpThemeYamlWithTimeoutMock.mockImplementation(parseWarpThemeYaml)
  })

  it('keeps same-basename manual file ids stable independent of dialog order', async () => {
    const firstPath = path.join('/Users/alice/light', 'duplicate.yaml')
    const secondPath = path.join('/Users/alice/dark', 'duplicate.yaml')
    readFileMock.mockImplementation((filePath: string) =>
      filePath === firstPath
        ? VALID_THEME.replace("background: '#111111'", "background: '#222222'")
        : VALID_THEME.replace("background: '#111111'", "background: '#333333'")
    )
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [firstPath, secondPath]
    })
    const firstPreview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' })

    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [secondPath, firstPath]
    })
    const secondPreview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' })

    expect(firstPreview.themes.map((theme) => theme.id)).toEqual(
      secondPreview.themes.map((theme) => theme.id)
    )
    const ids = firstPreview.themes.map((theme) => theme.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(ids.join(' ')).not.toContain('/Users/alice')
    expect(ids.every((id) => id.startsWith('warp:duplicate:duplicate-yaml-'))).toBe(true)
  })
})
