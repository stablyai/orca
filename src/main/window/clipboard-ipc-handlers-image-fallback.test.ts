import { beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

// Why: split from clipboard-ipc-handlers.test.ts to stay under the oxlint
// max-lines (800) limit; covers the #26739 raw-image paste fallback wiring.
const {
  handleMock,
  fsMkdirMock,
  fsOpendirMock,
  fsRmMock,
  fsWriteFileMock,
  clipboardReadBufferMock,
  clipboardReadImageMock,
  clipboardAvailableFormatsMock,
  nativeImageCreateFromBufferMock,
  randomUUIDMock,
  getSshFilesystemProviderMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fsMkdirMock: vi.fn(),
  fsOpendirMock: vi.fn(),
  fsRmMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  clipboardReadBufferMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  clipboardAvailableFormatsMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock
}))

vi.mock('node:fs/promises', () => ({
  mkdir: fsMkdirMock,
  opendir: fsOpendirMock,
  rm: fsRmMock,
  writeFile: fsWriteFileMock,
  default: { writeFile: fsWriteFileMock, mkdir: fsMkdirMock }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp')
  },
  clipboard: {
    readBuffer: clipboardReadBufferMock,
    readImage: clipboardReadImageMock,
    availableFormats: clipboardAvailableFormatsMock
  },
  ipcMain: {
    removeHandler: vi.fn(),
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

vi.mock('../ipc/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: vi.fn()
}))

vi.mock('../ipc/filesystem-auth', () => ({
  PATH_ACCESS_DENIED_MESSAGE:
    'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.',
  resolveAuthorizedPath: vi.fn(async (path: string) => path)
}))

vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

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

describe('clipboard saveImageAsTempFile raw image fallback', () => {
  beforeEach(() => {
    installFakeAppEnvironment({ getPath: () => '/tmp' })
    vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    handleMock.mockReset()
    fsMkdirMock.mockReset()
    fsMkdirMock.mockResolvedValue(undefined)
    fsOpendirMock.mockReset()
    // Why: handler registration kicks off the expired-staging sweep; an empty temp root keeps it inert.
    fsOpendirMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined)
    }))
    fsRmMock.mockReset()
    fsRmMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockReset()
    clipboardReadBufferMock.mockReset()
    clipboardReadBufferMock.mockReturnValue(Buffer.alloc(0))
    clipboardReadImageMock.mockReset()
    clipboardAvailableFormatsMock.mockReset()
    clipboardAvailableFormatsMock.mockReturnValue(['image/png'])
    nativeImageCreateFromBufferMock.mockReset()
    randomUUIDMock.mockReset()
    randomUUIDMock.mockReturnValue('00000000-0000-4000-8000-000000000000')
    getSshFilesystemProviderMock.mockReset()
  })

  it('saves a raw image flavor as PNG when the native decode is empty (#26739 CleanShot X)', async () => {
    // CleanShot X puts JPEG bytes under public.png; readImage comes back empty
    // and the paste used to fail silently.
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3])
    clipboardReadBufferMock.mockImplementation((format: string) =>
      format === 'image/png' ? jpeg : Buffer.alloc(0)
    )
    const png = Buffer.from([9, 8, 7, 6])
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ height: 2, width: 3 }),
      isEmpty: () => false,
      toPNG: () => png
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
    ).resolves.toBe('/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png')
    expect(clipboardReadBufferMock).toHaveBeenCalledWith('image/png')
    expect(nativeImageCreateFromBufferMock).toHaveBeenCalledWith(jpeg)
    expect(fsWriteFileMock).toHaveBeenCalledWith(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png
    )
    expect(getSshFilesystemProviderMock).not.toHaveBeenCalled()
  })

  it('throws when the clipboard advertises an image but no flavor decodes', async () => {
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })
    clipboardReadBufferMock.mockReturnValue(Buffer.from([1, 2, 3]))
    nativeImageCreateFromBufferMock.mockReturnValue({ isEmpty: () => true })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
    ).rejects.toThrow('Clipboard image could not be read')
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })
})
