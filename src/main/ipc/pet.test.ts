import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
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
import type { CustomPet } from '../../shared/pet-types'
import { MAX_BYTES } from './pet-import-size-limits'

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

  const generatedManifest = {
    spritesheetPath: 'spritesheet.webp',
    frame: { width: 2, height: 2 },
    fps: 8,
    defaultAnimation: 'idle',
    animations: { idle: { row: 0, frames: 2 }, running: { row: 1, frames: 2 } }
  }

  it('writes a generated pet as a bundle the renderer can already play', async () => {
    const sheet = webpVp8x(4, 4)

    const result = (await getHandler('pet:createGenerated')(
      { sender: {} },
      { sheet, manifest: generatedManifest, label: 'My dog' }
    )) as CustomPet

    expect(result).toMatchObject({
      label: 'My dog',
      fileName: 'spritesheet.webp',
      mimeType: 'image/webp',
      kind: 'bundle'
    })
    expect(result.sprite).toMatchObject({ frameWidth: 2, frameHeight: 2, columns: 2, rows: 2 })

    const dir = join(userDataDir, 'sidekicks', 'custom', result.id)
    await expect(readFile(join(dir, 'spritesheet.webp'))).resolves.toEqual(sheet)
    const written = JSON.parse(await readFile(join(dir, 'pet.json'), 'utf8'))
    expect(written.spritesheetPath).toBe('spritesheet.webp')
  })

  it('ignores a spritesheet path the renderer supplies', async () => {
    // The renderer never chooses where bytes land; a traversal attempt is simply
    // overwritten with the name main controls.
    const result = (await getHandler('pet:createGenerated')(
      { sender: {} },
      {
        sheet: webpVp8x(4, 4),
        manifest: { ...generatedManifest, spritesheetPath: '../../escaped.webp' },
        label: 'Escapee'
      }
    )) as CustomPet

    expect(result.fileName).toBe('spritesheet.webp')
    const written = JSON.parse(
      await readFile(join(userDataDir, 'sidekicks', 'custom', result.id, 'pet.json'), 'utf8')
    )
    expect(written.spritesheetPath).toBe('spritesheet.webp')
  })

  it('refuses a sheet past the import size limit', async () => {
    const huge = new ArrayBuffer(MAX_BYTES + 1)

    await expect(
      getHandler('pet:createGenerated')(
        { sender: {} },
        { sheet: huge, manifest: generatedManifest, label: 'Huge' }
      )
    ).rejects.toThrow(/size/i)
  })

  it('refuses a manifest that would not survive the bundle importer', async () => {
    await expect(
      getHandler('pet:createGenerated')(
        { sender: {} },
        {
          sheet: webpVp8x(4, 4),
          manifest: { ...generatedManifest, frame: { width: 0, height: 2 } },
          label: 'Bad'
        }
      )
    ).rejects.toThrow()
  })

  it('leaves nothing on disk when the sheet does not match the manifest', async () => {
    await expect(
      getHandler('pet:createGenerated')(
        { sender: {} },
        {
          // 5x4 is not a clean multiple of a 2x2 frame.
          sheet: webpVp8x(5, 4),
          manifest: generatedManifest,
          label: 'Mismatch'
        }
      )
    ).rejects.toThrow()

    const customDir = join(userDataDir, 'sidekicks', 'custom')
    const entries = await readdir(customDir).catch(() => [])
    expect(entries).toEqual([])
  })

  it('imports an image whose bytes match its name', async () => {
    const src = join(tempDir, 'real.png')
    await writeFile(src, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]))
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    const result = (await getHandler('pet:import')({ sender: {} })) as CustomPet

    expect(result).toMatchObject({ label: 'real', mimeType: 'image/png', kind: 'image' })
  })

  it('refuses a file that is only named like an image', async () => {
    // Extension-only validation let anything through under a .png name.
    const src = join(tempDir, 'not-really.png')
    await writeFile(src, Buffer.from('MZ   this is an executable', 'latin1'))
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    await expect(getHandler('pet:import')({ sender: {} })).rejects.toThrow(/image/i)
  })

  it('leaves nothing on disk when the bytes are refused', async () => {
    const src = join(tempDir, 'liar.png')
    await writeFile(src, Buffer.from('not an image at all'))
    showOpenDialogMock.mockResolvedValue({ canceled: false, filePaths: [src] })

    await expect(getHandler('pet:import')({ sender: {} })).rejects.toThrow()

    const entries = await readdir(join(userDataDir, 'sidekicks', 'custom')).catch(() => [])
    expect(entries).toEqual([])
  })
})
