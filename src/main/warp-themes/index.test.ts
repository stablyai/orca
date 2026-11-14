import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import type * as WarpThemeDiscovery from './discovery'

const opendirMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())
const realpathMock = vi.hoisted(() => vi.fn((filePath: string) => Promise.resolve(filePath)))
const statMock = vi.hoisted(() => vi.fn())
const getWarpThemeDirectoriesMock = vi.hoisted(() => vi.fn(() => ['/Users/alice/.warp/themes']))
const parseWarpThemeYamlWithTimeoutMock = vi.hoisted(() => vi.fn())
const showOpenDialogMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: showOpenDialogMock }
}))

vi.mock('fs/promises', () => ({
  opendir: opendirMock,
  readFile: readFileMock,
  realpath: realpathMock,
  stat: statMock
}))

vi.mock('./discovery', async (importOriginal) => {
  const actual = await importOriginal<typeof WarpThemeDiscovery>()
  return {
    ...actual,
    getWarpThemeDirectories: getWarpThemeDirectoriesMock
  }
})

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

function fileEntry(name: string) {
  return {
    name,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false
  }
}

function mockDirectory(
  entries: {
    name: string
    isFile: () => boolean
    isDirectory: () => boolean
    isSymbolicLink: () => boolean
  }[]
) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const entry of entries) {
        yield entry
      }
    }
  }
}

function mockStat(filePath: string) {
  return filePath.endsWith('themes')
    ? { isDirectory: () => true }
    : { isFile: () => true, size: VALID_THEME.length }
}

describe('previewWarpThemeImport', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWarpThemeDirectoriesMock.mockReturnValue(['/Users/alice/.warp/themes'])
    statMock.mockImplementation(mockStat)
    readFileMock.mockResolvedValue(VALID_THEME)
    realpathMock.mockImplementation((filePath: string) => Promise.resolve(filePath))
    opendirMock.mockResolvedValue(mockDirectory([fileEntry('z.yml'), fileEntry('a.yml')]))
    parseWarpThemeYamlWithTimeoutMock.mockImplementation(parseWarpThemeYaml)
  })

  it('keeps scanning later directories for unique themes after duplicate canonical files', async () => {
    const stableDirectory = '/Users/alice/.warp/themes'
    const previewDirectory = '/Users/alice/.warp-preview/themes'
    getWarpThemeDirectoriesMock.mockReturnValue([stableDirectory, previewDirectory])
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath === stableDirectory) {
        return Promise.resolve(
          mockDirectory(
            Array.from({ length: 199 }, (_, index) => fileEntry(`stable-${index}.yaml`))
          )
        )
      }
      if (directoryPath === previewDirectory) {
        return Promise.resolve(
          mockDirectory([
            fileEntry('duplicate-a.yaml'),
            fileEntry('duplicate-b.yaml'),
            fileEntry('unique.yaml')
          ])
        )
      }
      return Promise.resolve(mockDirectory([]))
    })
    realpathMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('duplicate-a.yaml')) {
        return Promise.resolve(path.join(stableDirectory, 'stable-0.yaml'))
      }
      if (filePath.endsWith('duplicate-b.yaml')) {
        return Promise.resolve(path.join(stableDirectory, 'stable-1.yaml'))
      }
      return Promise.resolve(filePath)
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(readFileMock).toHaveBeenCalledWith(path.join(previewDirectory, 'unique.yaml'), 'utf-8')
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

  it('stops streaming a large folder after the entry budget', async () => {
    const yieldedNames: string[] = []
    opendirMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (let index = 0; index < 1000; index += 1) {
          const name = `theme-${index}.yaml`
          yieldedNames.push(name)
          yield fileEntry(name)
        }
      }
    })

    await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(yieldedNames).toHaveLength(501)
    expect(yieldedNames).not.toContain('theme-501.yaml')
    expect(yieldedNames).not.toContain('theme-999.yaml')
  })
})
