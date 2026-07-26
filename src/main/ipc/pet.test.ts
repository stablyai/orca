import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  browserWindowFromWebContentsMock,
  browserWindowGetFocusedWindowMock,
  handleMock,
  showOpenDialogMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  browserWindowGetFocusedWindowMock: vi.fn(),
  handleMock: vi.fn(),
  showOpenDialogMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: appGetPathMock
  },
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock,
    getFocusedWindow: browserWindowGetFocusedWindowMock
  },
  dialog: {
    showOpenDialog: showOpenDialogMock
  },
  ipcMain: {
    handle: handleMock
  }
}))

import { registerPetHandlers } from './pet'
import type { CustomPet } from '../../shared/types'

describe('registerPetHandlers', () => {
  let tempDir: string
  let userDataDir: string
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>()

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-pet-test-'))
    userDataDir = join(tempDir, 'user-data')
    handlers.clear()
    appGetPathMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    browserWindowGetFocusedWindowMock.mockReset()
    handleMock.mockReset()
    showOpenDialogMock.mockReset()

    appGetPathMock.mockReturnValue(userDataDir)
    browserWindowFromWebContentsMock.mockReturnValue(null)
    browserWindowGetFocusedWindowMock.mockReturnValue(null)
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  function getHandler(channel: string): (event: unknown, ...args: unknown[]) => Promise<unknown> {
    registerPetHandlers()
    const handler = handlers.get(channel)
    if (!handler) {
      throw new Error(`${channel} handler not registered`)
    }
    return handler
  }

  function pngHeader(width: number, height: number): Buffer {
    const png = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(width, 16)
    png.writeUInt32BE(height, 20)
    return png
  }

  it('imports a pet bundle whose manifest uses Windows separators', async () => {
    const bundleDir = join(tempDir, 'windows-export.codex-pet')
    const sheetBytes = pngHeader(32, 24)
    await mkdir(join(bundleDir, 'assets'), { recursive: true })
    await writeFile(
      join(bundleDir, 'pet.json'),
      JSON.stringify({
        id: 'windows-export',
        displayName: 'Windows export',
        spritesheetPath: String.raw`assets\spritesheet.png`
      })
    )
    await writeFile(join(bundleDir, 'assets', 'spritesheet.png'), sheetBytes)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    const result = (await getHandler('pet:importPetBundle')({ sender: {} })) as CustomPet

    expect(result).toMatchObject({
      label: 'Windows export',
      fileName: 'spritesheet.png',
      mimeType: 'image/png',
      kind: 'bundle'
    })
    await expect(
      readFile(join(userDataDir, 'sidekicks', 'custom', result.id, 'spritesheet.png'))
    ).resolves.toEqual(sheetBytes)
  })

  function webpVp8x(width: number, height: number): Buffer {
    const u24 = (value: number): Buffer =>
      Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff])
    const payload = Buffer.concat([Buffer.from([0, 0, 0, 0]), u24(width - 1), u24(height - 1)])
    const size = Buffer.alloc(4)
    size.writeUInt32LE(payload.byteLength, 0)
    const riffSize = Buffer.alloc(4)
    riffSize.writeUInt32LE(4 + 8 + payload.byteLength, 0)
    return Buffer.concat([
      Buffer.from('RIFF'),
      riffSize,
      Buffer.from('WEBP'),
      Buffer.from('VP8X'),
      size,
      payload
    ])
  }

  async function writeSpriteBundle(
    animations: Record<string, { row: number; frames: number; frameDurationsMs?: number[] }>
  ): Promise<string> {
    const bundleDir = join(tempDir, 'durations.codex-pet')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(
      join(bundleDir, 'pet.json'),
      JSON.stringify({
        id: 'durations',
        displayName: 'Durations',
        spritesheetPath: 'sheet.webp',
        frame: { width: 2, height: 2 },
        animations
      })
    )
    await writeFile(join(bundleDir, 'sheet.webp'), webpVp8x(4, 2))
    return bundleDir
  }

  it('rejects unsafe raster dimensions from a metadata-free bundle before import', async () => {
    const bundleDir = join(tempDir, 'dimension-bomb.codex-pet')
    await mkdir(bundleDir, { recursive: true })
    await writeFile(
      join(bundleDir, 'pet.json'),
      JSON.stringify({
        spritesheetPath: 'sheet.png'
      })
    )
    await writeFile(join(bundleDir, 'sheet.png'), pngHeader(8_193, 512))
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    await expect(getHandler('pet:importPetBundle')({ sender: {} })).rejects.toThrow(
      'exceed the safe limit'
    )
  })

  it('imports an under-limit legacy raster without changing its bytes', async () => {
    const source = join(tempDir, 'safe-pet.png')
    const sourceBytes = pngHeader(64, 48)
    await writeFile(source, sourceBytes)
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [source] })

    const result = (await getHandler('pet:import')({ sender: {} })) as CustomPet

    expect(result).toMatchObject({ kind: 'image', mimeType: 'image/png' })
    await expect(
      readFile(join(userDataDir, 'sidekicks', 'custom', result.fileName))
    ).resolves.toEqual(sourceBytes)
  })

  it('rejects a legacy raster dimension bomb before copying it', async () => {
    const source = join(tempDir, 'dimension-bomb.png')
    await writeFile(source, pngHeader(32_768, 32_768))
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [source] })

    await expect(getHandler('pet:import')({ sender: {} })).rejects.toThrow('exceed the safe limit')
  })

  it('imports a bundle whose animations declare per-frame durations', async () => {
    const bundleDir = await writeSpriteBundle({
      idle: { row: 0, frames: 2, frameDurationsMs: [1680, 1920] }
    })
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    const result = (await getHandler('pet:importPetBundle')({ sender: {} })) as CustomPet

    expect(result.sprite?.animations?.idle).toEqual({
      row: 0,
      frames: 2,
      frameDurationsMs: [1680, 1920]
    })
  })

  it('rejects a bundle whose frame durations do not match the frame count', async () => {
    const bundleDir = await writeSpriteBundle({
      idle: { row: 0, frames: 2, frameDurationsMs: [1680] }
    })
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    await expect(getHandler('pet:importPetBundle')({ sender: {} })).rejects.toThrow(
      'declares 1 frame durations but 2 frames'
    )
  })

  it('reads a stored pet through the bounded file reader without changing its bytes', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const fileName = `${id}.png`
    const storedDir = join(userDataDir, 'sidekicks', 'custom')
    await mkdir(storedDir, { recursive: true })
    const storedBytes = pngHeader(4, 4)
    await writeFile(join(storedDir, fileName), storedBytes)

    const result = (await getHandler('pet:read')({}, id, fileName, 'image')) as ArrayBuffer

    expect(Buffer.from(result)).toEqual(storedBytes)
  })

  it('rejects a replaced legacy pet dimension bomb before renderer delivery', async () => {
    const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const fileName = `${id}.png`
    const storedDir = join(userDataDir, 'sidekicks', 'custom')
    await mkdir(storedDir, { recursive: true })
    await writeFile(join(storedDir, fileName), pngHeader(32_768, 32_768))

    await expect(getHandler('pet:read')({}, id, fileName, 'image')).resolves.toBeNull()
  })
})
