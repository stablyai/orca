import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  truncate,
  writeFile
} from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { fromWebContentsMock, getPathMock, handleMock, openPathMock, showOpenDialogMock } =
  vi.hoisted(() => ({
    fromWebContentsMock: vi.fn(),
    getPathMock: vi.fn(),
    handleMock: vi.fn(),
    openPathMock: vi.fn(),
    showOpenDialogMock: vi.fn()
  }))

const fileOpenRace = vi.hoisted(() => ({
  beforeOpen: null as ((path: string) => Promise<void>) | null
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const beforeOpen = fileOpenRace.beforeOpen
    fileOpenRace.beforeOpen = null
    await beforeOpen?.(String(args[0]))
    return actual.open(...args)
  }) as typeof actual.open
  return { ...actual, open }
})

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  app: { getPath: getPathMock },
  dialog: { showOpenDialog: showOpenDialogMock },
  ipcMain: { handle: handleMock },
  shell: { openPath: openPathMock }
}))

import {
  importOrcaBackgroundImages,
  listOrcaBackgroundLibrary,
  loadOrcaBackgroundImage,
  openOrcaBackgroundLibrary,
  registerOrcaBackgroundLibraryHandlers
} from './orca-background-library'

const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64'
)
const ALTERNATE_VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
)
const CORRUPT_PNG = Buffer.from([0x89, 0x50, 0x4e])

function oversizedPng(): Buffer {
  const bytes = Buffer.from(VALID_PNG)
  bytes.writeUInt32BE(32_769, 16)
  return bytes
}

const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-backgrounds-'))
  tempRoots.push(root)
  return root
}

describe('Orca background library', () => {
  beforeEach(() => {
    fromWebContentsMock.mockReset().mockReturnValue(null)
    handleMock.mockReset()
    openPathMock.mockReset().mockResolvedValue('')
    showOpenDialogMock.mockReset().mockResolvedValue({ canceled: true, filePaths: [] })
    getPathMock.mockReset()
    fileOpenRace.beforeOpen = null
  })

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('lists supported regular images in filename order', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    await mkdir(library)
    await writeFile(join(library, 'zeta.png'), ALTERNATE_VALID_PNG)
    await writeFile(join(library, 'alpha.PNG'), VALID_PNG)
    await writeFile(join(library, 'corrupt.png'), CORRUPT_PNG)
    await writeFile(join(library, 'oversized.png'), oversizedPng())
    await writeFile(join(library, 'unsupported.avif'), VALID_PNG)
    await writeFile(join(library, 'notes.txt'), 'not an image')
    await writeFile(join(library, 'empty.jpg'), '')
    await writeFile(join(library, 'large.png'), '')
    await truncate(join(library, 'large.png'), 12 * 1024 * 1024 + 1)

    await expect(listOrcaBackgroundLibrary(library)).resolves.toEqual({
      dir: library,
      images: [
        { fileName: 'alpha.PNG', path: join(library, 'alpha.PNG'), size: VALID_PNG.byteLength },
        {
          fileName: 'zeta.png',
          path: join(library, 'zeta.png'),
          size: ALTERNATE_VALID_PNG.byteLength
        }
      ]
    })
  })

  it('loads image bytes without allowing path traversal', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    await mkdir(library)
    await writeFile(join(library, 'scene.png'), VALID_PNG)
    await writeFile(join(root, 'secret.png'), ALTERNATE_VALID_PNG)

    await expect(loadOrcaBackgroundImage('scene.png', library)).resolves.toEqual({
      ok: true,
      data: Uint8Array.from(VALID_PNG),
      mimeType: 'image/png'
    })
    await expect(loadOrcaBackgroundImage('../secret.png', library)).resolves.toEqual({
      ok: false,
      reason: 'invalid-name'
    })
    await expect(loadOrcaBackgroundImage('..\\secret.png', library)).resolves.toEqual({
      ok: false,
      reason: 'invalid-name'
    })
  })

  it('rejects a file swapped between lstat and open', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    const imagePath = join(library, 'scene.png')
    const originalPath = join(library, 'original.png')
    const outsidePath = join(root, 'outside.png')
    await mkdir(library)
    await writeFile(imagePath, VALID_PNG)
    await writeFile(outsidePath, ALTERNATE_VALID_PNG)
    fileOpenRace.beforeOpen = async (openedPath) => {
      expect(openedPath).toBe(imagePath)
      await rename(imagePath, originalPath)
      await rename(outsidePath, imagePath)
    }

    const result = await loadOrcaBackgroundImage('scene.png', library)
    expect(result).toEqual({
      ok: false,
      reason: 'read-failed'
    })
    expect(result).not.toHaveProperty('data')
  })

  it('rejects hard links already present in the library', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    await mkdir(library)
    await writeFile(join(root, 'outside.png'), VALID_PNG)
    await link(join(root, 'outside.png'), join(library, 'linked.png'))

    await expect(loadOrcaBackgroundImage('linked.png', library)).resolves.toEqual({
      ok: false,
      reason: 'read-failed'
    })
    await expect(listOrcaBackgroundLibrary(library)).resolves.toEqual({ dir: library, images: [] })
  })

  it('rejects corrupt and unsafe-dimension image bytes', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    await mkdir(library)
    await writeFile(join(library, 'corrupt.png'), CORRUPT_PNG)
    await writeFile(join(library, 'oversized.png'), oversizedPng())

    await expect(loadOrcaBackgroundImage('corrupt.png', library)).resolves.toEqual({
      ok: false,
      reason: 'read-failed'
    })
    await expect(loadOrcaBackgroundImage('oversized.png', library)).resolves.toEqual({
      ok: false,
      reason: 'too-large'
    })
  })

  it('imports collision-safe copies without overwriting existing images', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    const sourceDir = join(root, 'source')
    await mkdir(library)
    await mkdir(sourceDir)
    await writeFile(join(library, 'scene.png'), VALID_PNG)
    await writeFile(join(sourceDir, 'scene.png'), ALTERNATE_VALID_PNG)

    const result = await importOrcaBackgroundImages([join(sourceDir, 'scene.png')], library)

    expect(result.added).toEqual(['scene-2.png'])
    await expect(readFile(join(library, 'scene.png'))).resolves.toEqual(VALID_PNG)
    await expect(readFile(join(library, 'scene-2.png'))).resolves.toEqual(ALTERNATE_VALID_PNG)
  })

  it('skips corrupt and unsafe-dimension imports', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    const sourceDir = join(root, 'source')
    await mkdir(sourceDir)
    await writeFile(join(sourceDir, 'valid.png'), VALID_PNG)
    await writeFile(join(sourceDir, 'corrupt.png'), CORRUPT_PNG)
    await writeFile(join(sourceDir, 'oversized.png'), oversizedPng())

    const result = await importOrcaBackgroundImages(
      [
        join(sourceDir, 'valid.png'),
        join(sourceDir, 'corrupt.png'),
        join(sourceDir, 'oversized.png')
      ],
      library
    )

    expect(result.added).toEqual(['valid.png'])
    expect(result.skipped).toEqual(['corrupt.png', 'oversized.png'])
    expect(result.images.map((image) => image.fileName)).toEqual(['valid.png'])
  })

  it.runIf(process.platform !== 'win32')('rejects symbolic links', async () => {
    const root = await makeTempRoot()
    const library = join(root, 'backgrounds')
    await mkdir(library)
    await writeFile(join(root, 'outside.png'), VALID_PNG)
    await symlink(join(root, 'outside.png'), join(library, 'linked.png'))

    await expect(loadOrcaBackgroundImage('linked.png', library)).resolves.toEqual({
      ok: false,
      reason: 'invalid-name'
    })
    await expect(listOrcaBackgroundLibrary(library)).resolves.toEqual({ dir: library, images: [] })
  })

  it('opens the app-owned folder and exposes only native-picker imports', async () => {
    const root = await makeTempRoot()
    const parentWindow = { id: 1 }
    const sender = { id: 2 }
    getPathMock.mockReturnValue(root)
    fromWebContentsMock.mockReturnValue(parentWindow)
    registerOrcaBackgroundLibraryHandlers()

    const channels = handleMock.mock.calls.map(([channel]) => channel)
    expect(channels).toEqual([
      'backgrounds:listLibrary',
      'backgrounds:addImages',
      'backgrounds:openLibrary',
      'backgrounds:loadImage'
    ])

    const addImages = handleMock.mock.calls.find(
      ([channel]) => channel === 'backgrounds:addImages'
    )?.[1] as (...args: unknown[]) => Promise<unknown>
    await expect(addImages({ sender }, ['C:\\untrusted\\secret.png'])).resolves.toMatchObject({
      added: [],
      skipped: []
    })
    expect(fromWebContentsMock).toHaveBeenCalledWith(sender)
    expect(showOpenDialogMock).toHaveBeenCalledOnce()
    expect(showOpenDialogMock).toHaveBeenCalledWith(parentWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Images',
          extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
        }
      ]
    })

    await expect(openOrcaBackgroundLibrary(join(root, 'backgrounds'))).resolves.toEqual({
      ok: true
    })
    expect(openPathMock).toHaveBeenCalledWith(join(root, 'backgrounds'))
  })
})
