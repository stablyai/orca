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
    animations: Record<
      string,
      {
        row: number
        frames: number
        frameDurationsMs?: number[]
        repeat?: number
        settleTo?: string
      }
    >,
    sheetWidth = 4
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
    await writeFile(join(bundleDir, 'sheet.webp'), webpVp8x(sheetWidth, 2))
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

  it('imports repeat and settleTo so app states can settle into idle', async () => {
    const bundleDir = await writeSpriteBundle({
      idle: { row: 0, frames: 2, frameDurationsMs: [1680, 1920] },
      running: { row: 0, frames: 2, frameDurationsMs: [120, 220], repeat: 3, settleTo: 'idle' }
    })
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    const result = (await getHandler('pet:importPetBundle')({ sender: {} })) as CustomPet

    expect(result.sprite?.animations?.running).toEqual({
      row: 0,
      frames: 2,
      frameDurationsMs: [120, 220],
      repeat: 3,
      settleTo: 'idle'
    })
  })

  it('rejects settle declarations the renderer would silently ignore', async () => {
    const invalid: [Record<string, Parameters<typeof writeSpriteBundle>[0][string]>, string][] = [
      // repeat without settleTo
      [
        { idle: { row: 0, frames: 2, frameDurationsMs: [100, 200], repeat: 3 } },
        'needs both repeat and settleTo'
      ],
      // settling into itself
      [
        {
          idle: { row: 0, frames: 2, frameDurationsMs: [100, 200], repeat: 3, settleTo: 'idle' }
        },
        'cannot settle to itself'
      ],
      // no durations on the settling row
      [
        {
          idle: { row: 0, frames: 2, frameDurationsMs: [100, 200] },
          running: { row: 0, frames: 2, repeat: 3, settleTo: 'idle' }
        },
        'must both carry frameDurationsMs'
      ],
      // no durations on the settle target
      [
        {
          idle: { row: 0, frames: 2 },
          running: { row: 0, frames: 2, frameDurationsMs: [120, 220], repeat: 3, settleTo: 'idle' }
        },
        'must both carry frameDurationsMs'
      ]
    ]
    for (const [animations, message] of invalid) {
      const bundleDir = await writeSpriteBundle(animations)
      showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

      await expect(getHandler('pet:importPetBundle')({ sender: {} })).rejects.toThrow(message)
    }
  })

  it('rejects a settleTo that names a missing animation', async () => {
    const bundleDir = await writeSpriteBundle({
      idle: { row: 0, frames: 2, settleTo: 'nap' }
    })
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    await expect(getHandler('pet:importPetBundle')({ sender: {} })).rejects.toThrow(
      'settles to "nap" which is not in animations'
    )
  })

  it('rejects repeats whose expanded frame count exceeds the keyframe cap', async () => {
    // A 2048px sheet gives 1024 columns, so 512 frames pass the column check
    // and only the repeat product trips.
    const bundleDir = await writeSpriteBundle(
      {
        idle: { row: 0, frames: 2 },
        running: { row: 0, frames: 512, repeat: 2, settleTo: 'idle' }
      },
      2048
    )
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [bundleDir] })

    await expect(getHandler('pet:importPetBundle')({ sender: {} })).rejects.toThrow(
      'exceeding the 512 keyframe cap'
    )
  })
})
