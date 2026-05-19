import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  fsWriteFileMock,
  clipboardReadTextMock,
  clipboardWriteTextMock,
  clipboardReadImageMock,
  clipboardWriteImageMock,
  nativeImageCreateFromBufferMock,
  randomUUIDMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  clipboardReadTextMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  clipboardWriteImageMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({
  default: {
    writeFile: fsWriteFileMock
  }
}))

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  },
  clipboard: {
    readText: clipboardReadTextMock,
    writeText: clipboardWriteTextMock,
    readImage: clipboardReadImageMock,
    writeImage: clipboardWriteImageMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBufferMock
  }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  requireSshFilesystemProvider: (connectionId: string) => {
    const provider = getSshFilesystemProviderMock(connectionId)
    if (!provider) {
      throw new Error(
        'Remote connection dropped. Click Reconnect on the SSH target before retrying.'
      )
    }
    return provider
  }
}))

import { registerClipboardHandlers } from './clipboard-ipc-handlers'

function getRegisteredHandlers(): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  for (const [channel, handler] of handleMock.mock.calls as [
    string,
    (...args: unknown[]) => unknown
  ][]) {
    handlers.set(channel, handler)
  }
  return handlers
}

describe('registerClipboardHandlers', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    fsWriteFileMock.mockReset()
    clipboardReadTextMock.mockReset()
    clipboardWriteTextMock.mockReset()
    clipboardReadImageMock.mockReset()
    clipboardWriteImageMock.mockReset()
    nativeImageCreateFromBufferMock.mockReset()
    randomUUIDMock.mockReset()
    randomUUIDMock.mockReturnValue('00000000-0000-4000-8000-000000000000')
    getSshFilesystemProviderMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers normal and selection text clipboard IPC handlers', () => {
    clipboardReadTextMock.mockImplementation((clipboardType?: string) =>
      clipboardType === 'selection' ? 'selection text' : 'standard text'
    )

    registerClipboardHandlers()

    const handlers = getRegisteredHandlers()
    expect(handlers.get('clipboard:readText')?.()).toBe('standard text')
    expect(handlers.get('clipboard:readSelectionText')?.()).toBe('selection text')
    handlers.get('clipboard:writeText')?.({}, 'normal text')
    handlers.get('clipboard:writeSelectionText')?.({}, 'primary text')

    expect(clipboardReadTextMock).toHaveBeenCalledWith()
    expect(clipboardReadTextMock).toHaveBeenCalledWith('selection')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('normal text')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('primary text', 'selection')
  })

  it('removes stale clipboard IPC handlers before registering replacements', () => {
    registerClipboardHandlers()

    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeImage')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:saveImageAsTempFile')
  })

  it('saves clipboard images to a local temp file when no connection is provided', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    clipboardReadImageMock.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => png
    })

    registerClipboardHandlers()

    const handlers = getRegisteredHandlers()
    await expect(handlers.get('clipboard:saveImageAsTempFile')?.({}, undefined)).resolves.toBe(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png'
    )
    expect(fsWriteFileMock).toHaveBeenCalledWith(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png
    )
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('uploads clipboard images to the SSH host when a connection is provided', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    const getTempDir = vi.fn().mockResolvedValue('/var/tmp')
    clipboardReadImageMock.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => png
    })
    getSshFilesystemProviderMock.mockReturnValue({ getTempDir, writeFileBase64 })

    registerClipboardHandlers()

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.({}, { connectionId: 'ssh-1' })
    ).resolves.toBe('/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png')
    expect(getSshFilesystemProviderMock).toHaveBeenCalledWith('ssh-1')
    expect(getTempDir).toHaveBeenCalled()
    expect(writeFileBase64).toHaveBeenCalledWith(
      '/var/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png.toString('base64')
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('uses Windows path joining for Windows SSH temp directories', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    const writeFileBase64 = vi.fn().mockResolvedValue(undefined)
    clipboardReadImageMock.mockReturnValue({
      isEmpty: () => false,
      toPNG: () => png
    })
    getSshFilesystemProviderMock.mockReturnValue({
      getTempDir: vi.fn().mockResolvedValue('C:\\Users\\alice\\AppData\\Local\\Temp'),
      writeFileBase64
    })

    registerClipboardHandlers()

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.({}, { connectionId: 'ssh-1' })
    ).resolves.toBe(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png'
    )
    expect(writeFileBase64).toHaveBeenCalledWith(
      'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png.toString('base64')
    )
  })
})
