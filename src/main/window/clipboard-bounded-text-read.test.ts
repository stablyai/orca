import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'
import { installFakeAppEnvironment } from '../../../config/scripts/test-runtime/environment/vitest-host-ports-setup'
import {
  CLIPBOARD_TEXT_READ_MAX_BYTES,
  CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR
} from '../../shared/clipboard-text'

const { runProcessMock, readClipboardTextDirectMock, handlerMocks } = vi.hoisted(() => ({
  runProcessMock: vi.fn<typeof ProcessHost.runProcess>(),
  readClipboardTextDirectMock: vi.fn(() => 'direct read'),
  handlerMocks: {
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    clipboardReadText: vi.fn()
  }
}))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  clipboard: {
    readText: handlerMocks.clipboardReadText,
    readBuffer: vi.fn(),
    availableFormats: vi.fn(() => [])
  },
  ipcMain: {
    removeHandler: (channel: string) => handlerMocks.handlers.delete(channel),
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlerMocks.handlers.set(channel, handler)
  },
  nativeImage: { createFromBuffer: vi.fn() }
}))
vi.mock('./clipboard-remote-file-copy', () => ({
  cleanupExpiredRemoteClipboardFiles: vi.fn(),
  scheduleLegacyRemoteClipboardFileCleanup: vi.fn()
}))
vi.mock('./native-chat-paste-files', () => ({
  restoreNativeChatPastes: vi.fn(),
  nativeChatPasteFolder: () => '/tmp/native-chat-pastes'
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  CLIPBOARD_TEXT_READ_BOUND_MS,
  readClipboardTextWithBoundedWait,
  type BoundedClipboardTextReadDeps
} from './clipboard-bounded-text-read'
import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

const helperResult = (
  overrides: Partial<Awaited<ReturnType<typeof ProcessHost.runProcess>>> = {}
) => ({
  code: 0,
  signal: null,
  stdout: 'helper text',
  stderr: '',
  timedOut: false,
  ...overrides
})

function darwinDeps(): BoundedClipboardTextReadDeps {
  return {
    runProcess: runProcessMock,
    readClipboardTextDirect: readClipboardTextDirectMock,
    platform: 'darwin'
  }
}

describe('bounded clipboard text read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the pasteboard string through a disposable pbpaste process on macOS', async () => {
    runProcessMock.mockResolvedValue(helperResult())

    await expect(readClipboardTextWithBoundedWait(darwinDeps())).resolves.toBe('helper text')
    expect(runProcessMock).toHaveBeenCalledWith({
      program: '/usr/bin/pbpaste',
      timeoutMs: CLIPBOARD_TEXT_READ_BOUND_MS,
      maxOutputBytes: CLIPBOARD_TEXT_READ_MAX_BYTES + 1,
      killOnOutputLimit: true
    })
    expect(readClipboardTextDirectMock).not.toHaveBeenCalled()
  })

  it('reports the clipboard as unresponsive instead of blocking when the owner never delivers', async () => {
    runProcessMock.mockResolvedValue(
      helperResult({ code: null, signal: 'SIGTERM', stdout: '', timedOut: true })
    )

    await expect(readClipboardTextWithBoundedWait(darwinDeps())).rejects.toThrow(
      CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR
    )
    expect(readClipboardTextDirectMock).not.toHaveBeenCalled()
  })

  it('falls back to the direct read when the helper process cannot spawn', async () => {
    runProcessMock.mockRejectedValue(new Error('spawn /usr/bin/pbpaste ENOENT'))

    await expect(readClipboardTextWithBoundedWait(darwinDeps())).resolves.toBe('direct read')
  })

  it('keeps the direct read on non-macOS platforms', async () => {
    runProcessMock.mockResolvedValue(helperResult())

    await expect(
      readClipboardTextWithBoundedWait({
        runProcess: runProcessMock,
        readClipboardTextDirect: readClipboardTextDirectMock,
        platform: 'linux'
      })
    ).resolves.toBe('direct read')
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})

describe('clipboard:readText macOS routing', () => {
  const trustedEvent = {
    sender: {
      id: 17,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    handlerMocks.handlers.clear()
    installFakeAppEnvironment({ getPath: () => '/tmp' })
    setTrustedClipboardRendererWebContentsId(17)
  })

  it('reads through the pbpaste helper and reports an unresponsive owner without hanging', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    registerClipboardHandlers({} as never)
    const readText = handlerMocks.handlers.get('clipboard:readText')
    if (!readText) {
      throw new Error('Missing clipboard:readText handler')
    }

    runProcessMock.mockResolvedValue(helperResult())
    await expect(readText(trustedEvent)).resolves.toBe('helper text')
    expect(runProcessMock.mock.calls[0][0].program).toBe('/usr/bin/pbpaste')
    expect(handlerMocks.clipboardReadText).not.toHaveBeenCalled()

    runProcessMock.mockResolvedValue(
      helperResult({ code: null, signal: 'SIGTERM', stdout: '', timedOut: true })
    )
    await expect(readText(trustedEvent)).rejects.toThrow(CLIPBOARD_TEXT_READ_UNRESPONSIVE_ERROR)
  })
})
