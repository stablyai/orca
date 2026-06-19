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
})
