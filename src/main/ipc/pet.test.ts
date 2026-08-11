import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  appGetPathMock,
  browserWindowFromWebContentsMock,
  browserWindowGetFocusedWindowMock,
  handleMock,
  nativeImageCreateFromBufferMock,
  showOpenDialogMock
} = vi.hoisted(() => ({
  appGetPathMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  browserWindowGetFocusedWindowMock: vi.fn(),
  handleMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
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
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBufferMock
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
    nativeImageCreateFromBufferMock.mockReset()
    showOpenDialogMock.mockReset()

    appGetPathMock.mockReturnValue(userDataDir)
    browserWindowFromWebContentsMock.mockReturnValue(null)
    browserWindowGetFocusedWindowMock.mockReturnValue(null)
    handleMock.mockImplementation((channel, handler) => {
      handlers.set(channel, handler)
    })
    nativeImageCreateFromBufferMock.mockReturnValue({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 })
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

  it('imports a pet bundle whose manifest uses Windows separators', async () => {
    const bundleDir = join(tempDir, 'windows-export.codex-pet')
    const sheetBytes = Buffer.from('not decoded without frame metadata')
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
})
