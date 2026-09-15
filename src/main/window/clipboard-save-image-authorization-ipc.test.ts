import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  clipboardReadImageMock,
  nativeImageCreateFromBufferMock,
  authorizeExternalPathMock,
  saveClipboardImageBufferAsTempFileMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
  authorizeExternalPathMock: vi.fn(),
  saveClipboardImageBufferAsTempFileMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  },
  clipboard: {
    readText: vi.fn(),
    readBuffer: vi.fn(),
    writeText: vi.fn(),
    readImage: clipboardReadImageMock,
    writeImage: vi.fn(),
    writeBuffer: vi.fn()
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBufferMock
  }
}))

vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))
vi.mock('./clipboard-image-temp-file', () => ({
  saveClipboardImageBufferAsTempFile: saveClipboardImageBufferAsTempFileMock
}))
vi.mock('../ipc/filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock,
  PATH_ACCESS_DENIED_MESSAGE: 'Access denied',
  resolveAuthorizedPath: vi.fn()
}))

import { registerClipboardHandlers } from './clipboard-ipc-handlers'

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const call = (handleMock.mock.calls as [string, (...args: unknown[]) => unknown][]).find(
    ([registeredChannel]) => registeredChannel === channel
  )
  if (!call) {
    throw new Error(`${channel} was not registered`)
  }
  return call[1]
}

function makeClipboardEvent(): { sender: Record<string, unknown> } {
  return {
    sender: {
      id: 17,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false
    }
  }
}

describe('clipboard:saveImageAsTempFile authorization', () => {
  beforeEach(() => {
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    clipboardReadImageMock.mockReset()
    nativeImageCreateFromBufferMock.mockReset()
    authorizeExternalPathMock.mockReset()
    saveClipboardImageBufferAsTempFileMock.mockReset()
  })

  it('authorizes a locally persisted clipboard image for hover previews', async () => {
    const png = Buffer.from([0, 1, 2, 3])
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    saveClipboardImageBufferAsTempFileMock.mockResolvedValue('/tmp/orca-paste.png')
    registerClipboardHandlers({} as never)

    await expect(
      getHandler('clipboard:saveImageAsTempFile')(makeClipboardEvent(), undefined)
    ).resolves.toBe('/tmp/orca-paste.png')
    expect(saveClipboardImageBufferAsTempFileMock).toHaveBeenCalledWith(png, undefined)
    expect(authorizeExternalPathMock).toHaveBeenCalledWith('/tmp/orca-paste.png')
  })
})
