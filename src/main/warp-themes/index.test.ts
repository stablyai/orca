import { beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'path'

const opendirMock = vi.hoisted(() => vi.fn())
const readFileMock = vi.hoisted(() => vi.fn())
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
  stat: statMock
}))

vi.mock('./discovery', () => ({
  getWarpThemeDirectories: getWarpThemeDirectoriesMock
}))

vi.mock('./parser-runner', () => ({
  parseWarpThemeYamlWithTimeout: parseWarpThemeYamlWithTimeoutMock
}))

import { previewWarpThemeImport } from './index'
import { parseWarpThemeYaml } from './parser'
import type { Store } from '../persistence'

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
    isDirectory: () => false
  }
}

function directoryEntry(name: string) {
  return {
    name,
    isFile: () => false,
    isDirectory: () => true
  }
}

function mockDirectory(
  entries: { name: string; isFile: () => boolean; isDirectory: () => boolean }[]
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
    opendirMock.mockResolvedValue(mockDirectory([fileEntry('z.yml'), fileEntry('a.yml')]))
    parseWarpThemeYamlWithTimeoutMock.mockImplementation(parseWarpThemeYaml)
  })

  it('sorts theme files before duplicate id suffixing', async () => {
    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes.map((theme) => theme.id)).toEqual([
      'warp:duplicate:a-yml',
      'warp:duplicate:z-yml'
    ])
    expect(readFileMock.mock.calls.map(([filePath]) => path.basename(filePath as string))).toEqual([
      'a.yml',
      'z.yml'
    ])
  })

  it('returns an empty errorless preview when no local Warp theme folder exists', async () => {
    statMock.mockImplementation(() => {
      throw new Error('missing local themes')
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview).toMatchObject({
      found: false,
      sourceLabel: 'Warp themes',
      themes: [],
      skippedFiles: []
    })
    expect(preview.error).toBeUndefined()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('returns an empty errorless preview for an empty readable local Warp theme folder', async () => {
    opendirMock.mockResolvedValue(mockDirectory([]))

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview).toMatchObject({
      found: false,
      sourceLabel: 'Warp themes',
      themes: [],
      skippedFiles: []
    })
    expect(preview.error).toBeUndefined()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('reports bounded skips when local Warp folders are unreadable', async () => {
    opendirMock.mockRejectedValue(
      new Error("EACCES: permission denied, scandir '/Users/alice/.warp/themes'")
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.found).toBe(false)
    expect(preview.sourceLabel).toBe('Warp themes')
    expect(preview.skippedFiles).toEqual([{ label: 'themes', reason: 'Could not read folder.' }])
    expect(preview.themes).toEqual([])
  })

  it('labels auto-discovered themes as local Warp themes', async () => {
    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.sourceLabel).toBe('Warp themes')
    expect(preview.themes.map((theme) => theme.name)).toEqual(['Duplicate', 'Duplicate'])
    expect(preview.themes.map((theme) => theme.sourceLabel)).toEqual([
      'Local Warp themes',
      'Local Warp themes'
    ])
  })

  it('returns a bounded preview error for invalid sources without auto discovery', async () => {
    const preview = await previewWarpThemeImport({} as Store, { kind: 'surprise' })
    const nullPreview = await previewWarpThemeImport({} as Store, null)
    const extraFieldPreview = await previewWarpThemeImport({} as Store, {
      kind: 'auto',
      path: '/Users/alice/.warp/themes'
    })

    expect(preview).toEqual({
      found: false,
      themes: [],
      skippedFiles: [],
      error: 'Invalid Warp theme import source.'
    })
    expect(nullPreview.error).toBe('Invalid Warp theme import source.')
    expect(extraFieldPreview.error).toBe('Invalid Warp theme import source.')
    expect(getWarpThemeDirectoriesMock).not.toHaveBeenCalled()
  })

  it('uses stable file labels in imported theme ids', async () => {
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath.endsWith('themes')) {
        return Promise.resolve(
          mockDirectory([directoryEntry('standard'), directoryEntry('custom')])
        )
      }
      if (directoryPath.endsWith('standard')) {
        return Promise.resolve(mockDirectory([fileEntry('duplicate.yaml')]))
      }
      if (directoryPath.endsWith('custom')) {
        return Promise.resolve(mockDirectory([fileEntry('duplicate.yaml')]))
      }
      return Promise.resolve(mockDirectory([]))
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes.map((theme) => theme.id)).toEqual([
      'warp:duplicate:custom-duplicate-yaml',
      'warp:duplicate:standard-duplicate-yaml'
    ])
  })

  it('stops scheduling parser work when the preview budget expires', async () => {
    let currentTime = 0
    parseWarpThemeYamlWithTimeoutMock.mockImplementation(
      (...args: Parameters<typeof parseWarpThemeYaml>) => {
        currentTime = 10
        return parseWarpThemeYaml(...args)
      }
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' }, undefined, {
      operationBudgetMs: 5,
      now: () => currentTime
    })

    expect(preview.themes).toHaveLength(1)
    expect(parseWarpThemeYamlWithTimeoutMock).toHaveBeenCalledTimes(1)
    expect(parseWarpThemeYamlWithTimeoutMock.mock.calls[0]?.[3]).toEqual({ timeoutMs: 5 })
    expect(preview.skippedFiles).toContainEqual({
      label: 'Warp themes',
      reason: 'Preview budget expired before 1 theme file could be parsed.'
    })
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

  it('marks dismissed file pickers as canceled', async () => {
    showOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' })

    expect(preview).toEqual({ found: false, canceled: true, themes: [], skippedFiles: [] })
  })

  it('starts the preview budget after a manual file picker returns', async () => {
    let currentTime = 0
    showOpenDialogMock.mockImplementationOnce(() => {
      currentTime = 10
      return Promise.resolve({
        canceled: false,
        filePaths: [path.join('/Users/alice/themes', 'manual.yaml')]
      })
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' }, undefined, {
      operationBudgetMs: 5,
      now: () => currentTime
    })

    expect(preview.themes).toHaveLength(1)
    expect(parseWarpThemeYamlWithTimeoutMock.mock.calls[0]?.[3]).toEqual({ timeoutMs: 5 })
    expect(preview.skippedFiles).toEqual([])
  })

  it('starts the preview budget after a manual folder picker returns', async () => {
    let currentTime = 0
    showOpenDialogMock.mockImplementationOnce(() => {
      currentTime = 10
      return Promise.resolve({
        canceled: false,
        filePaths: ['/Users/alice/themes']
      })
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'chooseFolder' }, undefined, {
      operationBudgetMs: 5,
      now: () => currentTime
    })

    expect(preview.themes).toHaveLength(2)
    expect(parseWarpThemeYamlWithTimeoutMock.mock.calls[0]?.[3]).toEqual({ timeoutMs: 5 })
    expect(preview.skippedFiles).toEqual([])
  })

  it('finds themes in a cloned Warp themes repository layout', async () => {
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath.endsWith('themes')) {
        return Promise.resolve(
          mockDirectory([directoryEntry('standard'), directoryEntry('warp_bundled')])
        )
      }
      if (directoryPath.endsWith('standard')) {
        return Promise.resolve(mockDirectory([fileEntry('tokyo-night.yaml')]))
      }
      if (directoryPath.endsWith('warp_bundled')) {
        return Promise.resolve(mockDirectory([fileEntry('dracula.yml')]))
      }
      return Promise.resolve(mockDirectory([]))
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.found).toBe(true)
    expect(readFileMock.mock.calls.map(([filePath]) => filePath)).toEqual([
      path.join('/Users/alice/.warp/themes', 'standard', 'tokyo-night.yaml'),
      path.join('/Users/alice/.warp/themes', 'warp_bundled', 'dracula.yml')
    ])
    expect(preview.themes.map((theme) => theme.sourceLabel)).toEqual([
      'Local Warp themes',
      'Local Warp themes'
    ])
  })

  it('caps broad folder scans before walking unbounded child directories', async () => {
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath.endsWith('themes')) {
        return Promise.resolve(
          mockDirectory(
            Array.from({ length: 100 }, (_, index) => directoryEntry(`folder-${index}`))
          )
        )
      }
      return Promise.resolve(mockDirectory([fileEntry(`${path.basename(directoryPath)}.yaml`)]))
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(79)
    expect(preview.skippedFiles).toContainEqual({
      label: 'themes',
      reason: 'Only the first 80 folders were scanned.'
    })
  })

  it('reports the theme cap when a nested folder fills the cap before later folders', async () => {
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath.endsWith('themes')) {
        return Promise.resolve(
          mockDirectory([directoryEntry('standard'), directoryEntry('warp_bundled')])
        )
      }
      if (directoryPath.endsWith('standard')) {
        return Promise.resolve(
          mockDirectory(Array.from({ length: 200 }, (_, index) => fileEntry(`theme-${index}.yaml`)))
        )
      }
      if (directoryPath.endsWith('warp_bundled')) {
        return Promise.resolve(mockDirectory([fileEntry('extra.yaml')]))
      }
      return Promise.resolve(mockDirectory([]))
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).toContainEqual({
      label: 'themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
    expect(opendirMock).not.toHaveBeenCalledWith(
      path.join('/Users/alice/.warp/themes', 'warp_bundled'),
      expect.anything()
    )
  })

  it('caps entries processed from one large folder', async () => {
    opendirMock.mockResolvedValue(
      mockDirectory(Array.from({ length: 501 }, (_, index) => fileEntry(`theme-${index}.yaml`)))
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).toEqual(
      expect.arrayContaining([
        {
          label: 'themes',
          reason: 'Only the first 500 folder entries were scanned.'
        },
        {
          label: 'themes',
          reason: 'Only the first 200 theme files were scanned.'
        }
      ])
    )
  })

  it('does not report a skipped theme file warning for exactly the folder cap', async () => {
    opendirMock.mockResolvedValue(
      mockDirectory(Array.from({ length: 200 }, (_, index) => fileEntry(`theme-${index}.yaml`)))
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).not.toContainEqual({
      label: 'themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
  })

  it('does not report the theme cap for exactly the folder cap plus non-theme files', async () => {
    opendirMock.mockResolvedValue(
      mockDirectory([
        ...Array.from({ length: 200 }, (_, index) => fileEntry(`theme-${index}.yaml`)),
        fileEntry('z-readme.md')
      ])
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).not.toContainEqual({
      label: 'themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
  })

  it('does not report the theme cap when a nested folder fills the cap before non-theme siblings', async () => {
    opendirMock.mockImplementation((directoryPath: string) => {
      if (directoryPath.endsWith('themes')) {
        return Promise.resolve(
          mockDirectory([directoryEntry('standard'), fileEntry('z-readme.md')])
        )
      }
      if (directoryPath.endsWith('standard')) {
        return Promise.resolve(
          mockDirectory(Array.from({ length: 200 }, (_, index) => fileEntry(`theme-${index}.yaml`)))
        )
      }
      return Promise.resolve(mockDirectory([]))
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).not.toContainEqual({
      label: 'themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
  })

  it('reports capped manually selected theme files after deterministic YAML sorting', async () => {
    const themePaths = Array.from({ length: 201 }, (_, index) =>
      path.join('/Users/alice/warp-themes', `theme-${String(index).padStart(3, '0')}.yaml`)
    )
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [
        path.join('/Users/alice/warp-themes', 'aaa-not-theme.txt'),
        ...themePaths
      ].reverse()
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' })

    expect(preview.themes).toHaveLength(200)
    expect(readFileMock.mock.calls[0]?.[0]).toBe(themePaths[0])
    expect(readFileMock.mock.calls.at(-1)?.[0]).toBe(themePaths[199])
    expect(preview.skippedFiles).toContainEqual({
      label: 'Selected Warp themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
  })

  it('does not report the manual theme cap for extra non-YAML selections', async () => {
    const themePaths = Array.from({ length: 200 }, (_, index) =>
      path.join('/Users/alice/warp-themes', `theme-${String(index).padStart(3, '0')}.yaml`)
    )
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: [...themePaths, path.join('/Users/alice/warp-themes', 'readme.txt')]
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'chooseFile' })

    expect(preview.themes).toHaveLength(200)
    expect(preview.skippedFiles).not.toContainEqual({
      label: 'Selected Warp themes',
      reason: 'Only the first 200 theme files were scanned.'
    })
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

  it('does not copy absolute folder paths into skipped reasons', async () => {
    opendirMock.mockRejectedValue(
      new Error("ENOENT: no such file or directory, scandir '/Users/alice/.warp/themes'")
    )

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.skippedFiles).toEqual([{ label: 'themes', reason: 'Could not read folder.' }])
  })

  it('does not copy absolute file paths into skipped reasons', async () => {
    opendirMock.mockResolvedValue(mockDirectory([fileEntry('private.yml')]))
    statMock.mockImplementation((filePath: string) => {
      if (filePath.endsWith('private.yml')) {
        throw new Error("EACCES: permission denied, stat '/Users/alice/.warp/themes/private.yml'")
      }
      return mockStat(filePath)
    })

    const preview = await previewWarpThemeImport({} as Store, { kind: 'auto' })

    expect(preview.skippedFiles).toEqual([{ label: 'private.yml', reason: 'Could not read file.' }])
  })
})
