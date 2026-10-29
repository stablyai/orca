import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ProcessHost from '@orca/process-host'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import { CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS } from '../../shared/clipboard-text'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS,
  CLIPBOARD_IMAGE_MAX_PIXELS,
  CLIPBOARD_IMAGE_MAX_SOURCE_BYTES
} from '../../shared/clipboard-image'

const {
  removeHandlerMock,
  handleMock,
  runProcessMock,
  resolveAuthorizedPathMock,
  fsAccessMock,
  fsLstatMock,
  fsMkdirMock,
  fsOpendirMock,
  fsRmMock,
  fsWriteFileMock,
  fsOpenMock,
  fsStatMock,
  clipboardReadTextMock,
  clipboardReadBufferMock,
  clipboardWriteTextMock,
  clipboardReadImageMock,
  clipboardAvailableFormatsMock,
  clipboardWriteImageMock,
  clipboardWriteBufferMock,
  nativeImageCreateFromBufferMock,
  randomUUIDMock,
  callRuntimeEnvironmentMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  runProcessMock: vi.fn<typeof ProcessHost.runProcess>(),
  resolveAuthorizedPathMock: vi.fn(),
  fsAccessMock: vi.fn(),
  fsLstatMock: vi.fn(),
  fsMkdirMock: vi.fn(),
  fsOpendirMock: vi.fn(),
  fsRmMock: vi.fn(),
  fsWriteFileMock: vi.fn(),
  fsOpenMock: vi.fn(),
  fsStatMock: vi.fn(),
  clipboardReadTextMock: vi.fn(),
  clipboardReadBufferMock: vi.fn(),
  clipboardWriteTextMock: vi.fn(),
  clipboardReadImageMock: vi.fn(),
  clipboardAvailableFormatsMock: vi.fn(),
  clipboardWriteImageMock: vi.fn(),
  clipboardWriteBufferMock: vi.fn(),
  nativeImageCreateFromBufferMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000'),
  callRuntimeEnvironmentMock: vi.fn()
}))

vi.mock('@orca/process-host', async (importOriginal) => ({
  ...(await importOriginal<typeof ProcessHost>()),
  runProcess: runProcessMock
}))

vi.mock('node:fs/promises', () => ({
  access: fsAccessMock,
  lstat: fsLstatMock,
  mkdir: fsMkdirMock,
  opendir: fsOpendirMock,
  rm: fsRmMock,
  open: fsOpenMock,
  stat: fsStatMock,
  realpath: vi.fn(), // unused here; only satisfies filesystem-path-containment's named import
  writeFile: fsWriteFileMock,
  default: { writeFile: fsWriteFileMock, mkdir: fsMkdirMock }
}))

vi.mock('../ipc/filesystem/filesystem-auth', () => ({
  PATH_ACCESS_DENIED_MESSAGE:
    'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.',
  resolveAuthorizedPath: resolveAuthorizedPathMock
}))

vi.mock('node:crypto', () => ({
  randomUUID: randomUUIDMock
}))

vi.mock('electron', () => ({
  app: {
    commandLine: { getSwitchValue: vi.fn(() => 'x11') },
    getPath: vi.fn(() => '/tmp')
  },
  clipboard: {
    readText: clipboardReadTextMock,
    readBuffer: clipboardReadBufferMock,
    writeText: clipboardWriteTextMock,
    readImage: clipboardReadImageMock,
    availableFormats: clipboardAvailableFormatsMock,
    writeImage: clipboardWriteImageMock,
    writeBuffer: clipboardWriteBufferMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  nativeImage: {
    createFromBuffer: nativeImageCreateFromBufferMock
  }
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))
vi.mock('./dashboard-popout-window', () => ({ isDashboardPopoutRenderer: () => false }))

import {
  registerClipboardHandlers,
  setTrustedClipboardRendererWebContentsId
} from './clipboard-ipc-handlers'

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

function registerMockClipboardHandlers(): Map<string, (...args: unknown[]) => unknown> {
  // SAFETY: Path authorization is mocked; these clipboard handlers do not read Store state.
  registerClipboardHandlers({} as never)
  return getRegisteredHandlers()
}

function makeClipboardEvent(senderOverrides: Record<string, unknown> = {}): {
  sender: Record<string, unknown>
} {
  return {
    sender: {
      id: 17,
      getType: () => 'window',
      getURL: () => 'file:///orca/index.html',
      isDestroyed: () => false,
      ...senderOverrides
    }
  }
}

function trackPromiseSettled(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  return () => settled
}

function shellIdListArray(childCount: number): Buffer {
  const value = Buffer.alloc(4 + 4 * (childCount + 1))
  value.writeUInt32LE(childCount)
  return value
}

describe('registerClipboardHandlers', () => {
  beforeEach(() => {
    installFakeAppEnvironment({ getPath: () => '/tmp' })
    vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    runProcessMock.mockReset()
    runProcessMock.mockResolvedValue({
      code: 0,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false
    })
    resolveAuthorizedPathMock.mockReset()
    resolveAuthorizedPathMock.mockImplementation(async (path: string) => path)
    fsLstatMock.mockReset()
    fsLstatMock.mockResolvedValue({
      isDirectory: () => true,
      isSymbolicLink: () => false,
      mode: 0o700,
      uid: typeof process.getuid === 'function' ? process.getuid() : 0
    })
    fsMkdirMock.mockReset()
    fsMkdirMock.mockResolvedValue(undefined)
    fsOpendirMock.mockReset()
    // Registration starts expired-staging cleanup; an empty temp root keeps it inert.
    fsOpendirMock.mockImplementation(async () => ({
      async *[Symbol.asyncIterator]() {},
      close: vi.fn().mockResolvedValue(undefined)
    }))
    fsRmMock.mockReset()
    fsRmMock.mockResolvedValue(undefined)
    fsWriteFileMock.mockReset()
    fsOpenMock.mockReset()
    fsStatMock.mockReset()
    fsStatMock.mockResolvedValue({})
    clipboardReadTextMock.mockReset()
    clipboardReadBufferMock.mockReset()
    clipboardReadBufferMock.mockReturnValue(Buffer.alloc(0))
    clipboardWriteTextMock.mockReset()
    clipboardAvailableFormatsMock.mockReturnValue(['image/png'])
    clipboardReadImageMock.mockReset()
    clipboardWriteImageMock.mockReset()
    clipboardWriteBufferMock.mockReset()
    nativeImageCreateFromBufferMock.mockReset()
    randomUUIDMock.mockReset()
    randomUUIDMock.mockReturnValue('00000000-0000-4000-8000-000000000000')
    callRuntimeEnvironmentMock.mockReset()
    setTrustedClipboardRendererWebContentsId(17)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('registers normal and selection text clipboard IPC handlers', async () => {
    const values = { standard: 'standard text', selection: 'selection text' }
    clipboardReadTextMock.mockImplementation((type?: string) =>
      type === 'selection' ? values.selection : values.standard
    )
    clipboardWriteTextMock.mockImplementation((text: string, type?: string) => {
      if (type === 'selection') {
        values.selection = text
      } else {
        values.standard = text
      }
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(handlers.get('clipboard:readText')?.(makeClipboardEvent())).resolves.toBe(
      'standard text'
    )
    await expect(handlers.get('clipboard:readSelectionText')?.(makeClipboardEvent())).resolves.toBe(
      'selection text'
    )
    await handlers.get('clipboard:writeText')?.(makeClipboardEvent(), 'normal text')
    await handlers.get('clipboard:writeSelectionText')?.(makeClipboardEvent(), 'primary text')

    expect(clipboardReadTextMock).toHaveBeenCalledWith()
    expect(clipboardReadTextMock).toHaveBeenCalledWith('selection')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('normal text')
    expect(clipboardWriteTextMock).toHaveBeenCalledWith('primary text', 'selection')
  })

  it.each(['clipboard:writeText', 'clipboard:writeTerminalText'])(
    'keeps a newer image after %s yields without blocking primary selection',
    async (channel) => {
      vi.useFakeTimers()
      const publications: string[] = []
      let textValue = ''
      clipboardReadTextMock.mockImplementation(() => textValue)
      clipboardWriteTextMock.mockImplementation((text: string, selection?: string) => {
        if (selection === 'selection') {
          publications.push('selection')
        } else {
          textValue = text
          publications.push('text')
        }
      })
      nativeImageCreateFromBufferMock.mockReturnValue({
        getSize: () => ({ width: 2, height: 2 }),
        isEmpty: () => false
      })
      clipboardWriteImageMock.mockImplementation(() => publications.push('image'))
      const handlers = registerMockClipboardHandlers()
      const large = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS * 2)
      const text = handlers.get(channel)?.(makeClipboardEvent(), large)
      const image = handlers.get('clipboard:writeImage')?.(
        makeClipboardEvent(),
        'data:image/png;base64,AAAA'
      )
      await handlers.get('clipboard:writeSelectionText')?.(makeClipboardEvent(), 'primary')
      const whileTextPending = [...publications]
      const decodedWhileTextPending = nativeImageCreateFromBufferMock.mock.calls.length
      await vi.runAllTimersAsync()
      await Promise.all([text, image])
      expect(whileTextPending).toEqual(['selection'])
      expect(decodedWhileTextPending).toBe(0)
      expect(publications).toEqual(['selection', 'text', 'image'])
    }
  )

  it.each(['path resolution', 'helper publication'])(
    'keeps newer text after an older file stalls at %s',
    async (stage) => {
      vi.useFakeTimers()
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      let release: () => void = () => undefined
      let onEntered: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const entered = new Promise<void>((resolve) => {
        onEntered = resolve
      })
      const publications: string[] = []
      if (stage === 'path resolution') {
        resolveAuthorizedPathMock.mockImplementationOnce(async (path: string) => {
          onEntered()
          await gate
          return path
        })
      }
      runProcessMock.mockImplementationOnce(async () => {
        if (stage === 'helper publication') {
          onEntered()
          await gate
        }
        publications.push('file')
        return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
      })
      clipboardWriteTextMock.mockImplementation(() => publications.push('text'))
      const handlers = registerMockClipboardHandlers()
      const file = handlers.get('clipboard:writeFile')?.(
        makeClipboardEvent(),
        '/tmp/copied-file.txt'
      )
      await entered
      const text = handlers.get('clipboard:writeText')?.(makeClipboardEvent(), 'newer')
      await vi.advanceTimersByTimeAsync(1_000)
      const whileFilePending = [...publications]
      release()
      await expect(file).resolves.toEqual({ ok: true })
      await text
      expect(whileFilePending).toEqual([])
      expect(publications).toEqual(['file', 'text'])
    }
  )

  it('keeps an older valid text copy when newer image and file requests are rejected', async () => {
    vi.useFakeTimers()
    nativeImageCreateFromBufferMock.mockReturnValue({ isEmpty: () => true })
    resolveAuthorizedPathMock.mockRejectedValueOnce(
      new Error(
        'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
      )
    )
    const handlers = registerMockClipboardHandlers()
    const large = 'x'.repeat(CLIPBOARD_TEXT_MEASURE_YIELD_CODE_UNITS * 2)
    const text = handlers.get('clipboard:writeText')?.(makeClipboardEvent(), large)
    const image = handlers.get('clipboard:writeImage')?.(
      makeClipboardEvent(),
      'data:image/png;base64,AAAA'
    )
    const file = handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/tmp/denied.txt')
    await vi.runAllTimersAsync()
    await Promise.all([text, image])
    await expect(file).resolves.toEqual({ ok: false, reason: 'access-denied' })
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(large)
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
    await handlers.get('clipboard:writeText')?.(makeClipboardEvent(), 'after rejection')
    expect(clipboardWriteTextMock).toHaveBeenLastCalledWith('after rejection')
  })

  it('rejects a full image/file queue before decoding or resolving another payload', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    let release: () => void = () => undefined
    let onEntered: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      onEntered = resolve
    })
    resolveAuthorizedPathMock.mockImplementationOnce(async (path: string) => {
      onEntered()
      await gate
      return path
    })
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ width: 2, height: 2 }),
      isEmpty: () => false
    })
    const handlers = registerMockClipboardHandlers()
    const file = handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/tmp/copied-file.txt')
    await entered
    const images = Array.from({ length: 31 }, () =>
      handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), 'data:image/png;base64,AAAA')
    )
    await expect(
      handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), 'data:image/png;base64,AAAA')
    ).rejects.toThrow('Too many pending clipboard writes')
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/tmp/overflow.txt')
    ).resolves.toEqual({ ok: false, reason: 'clipboard-busy' })
    const decodedWhileBlocked = nativeImageCreateFromBufferMock.mock.calls.length
    const resolvedWhileBlocked = resolveAuthorizedPathMock.mock.calls.length
    release()
    await expect(file).resolves.toEqual({ ok: true })
    await Promise.all(images)
    expect(decodedWhileBlocked).toBe(0)
    expect(resolvedWhileBlocked).toBe(1)
    expect(clipboardWriteImageMock).toHaveBeenCalledTimes(31)
    await handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), 'data:image/png;base64,AAAA')
    expect(clipboardWriteImageMock).toHaveBeenCalledTimes(32)
  })

  it('rejects clipboard IPC from senders outside the current main renderer', async () => {
    setTrustedClipboardRendererWebContentsId(17)
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const untrustedEvent = makeClipboardEvent({ id: 42 })
    await expect(handlers.get('clipboard:readText')?.(untrustedEvent)).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )
    await expect(
      handlers.get('clipboard:writeText')?.(untrustedEvent, 'copied-secret-token-value')
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(untrustedEvent, {
        connectionId: 'ssh-secret'
      })
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    expect(() =>
      handlers.get('clipboard:writeFile')?.(untrustedEvent, '/tmp/copied-file.txt')
    ).toThrow('Unauthorized clipboard IPC sender')
    expect(() =>
      handlers.get('clipboard:writeImage')?.(untrustedEvent, 'data:image/png;base64,AAAA')
    ).toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadTextMock).not.toHaveBeenCalled()
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
    expect(clipboardReadImageMock).not.toHaveBeenCalled()
    expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
  })

  it('writes local files through the trusted handler into process-host', async () => {
    // Pinned so the process-host wiring runs on every CI host, macOS included.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/tmp/copied-file.txt')
    ).resolves.toEqual({ ok: true })

    expect(fsStatMock).toHaveBeenCalledWith('/tmp/copied-file.txt')
    expect(resolveAuthorizedPathMock.mock.calls[0]?.[0]).toBe('/tmp/copied-file.txt')
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })

  it('rejects unauthorized local files before touching the OS clipboard', async () => {
    resolveAuthorizedPathMock.mockRejectedValue(
      new Error(
        'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'
      )
    )
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeFile')?.(makeClipboardEvent(), '/etc/passwd')
    ).resolves.toEqual({ ok: false, reason: 'access-denied' })

    expect(fsStatMock).not.toHaveBeenCalled()
    expect(clipboardWriteBufferMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('rejects clipboard IPC from unpinned file://, destroyed, browser, and mismatched dev-origin senders', async () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ isDestroyed: () => true }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ getType: () => 'webview' }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')

    setTrustedClipboardRendererWebContentsId(null)
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    await expect(handlers.get('clipboard:readText')?.(makeClipboardEvent())).rejects.toThrow(
      'Unauthorized clipboard IPC sender'
    )

    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    await expect(
      handlers.get('clipboard:readText')?.(
        makeClipboardEvent({ getURL: () => 'http://127.0.0.1:5173/workspace' })
      )
    ).rejects.toThrow('Unauthorized clipboard IPC sender')
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent({ getURL: () => 'not a url' }))
    ).rejects.toThrow('Unauthorized clipboard IPC sender')

    expect(clipboardReadTextMock).not.toHaveBeenCalled()
  })

  it('rejects oversized text clipboard IPC reads without returning clipboard contents', async () => {
    clipboardReadTextMock.mockImplementation((clipboardType?: string) =>
      clipboardType === 'selection' ? 'selection secret' : 'standard secret'
    )

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:readText')?.(makeClipboardEvent(), { maxBytes: 4 })
    ).rejects.toThrow('Clipboard text is too large for this paste target.')
    await expect(
      handlers.get('clipboard:readSelectionText')?.(makeClipboardEvent(), { maxBytes: 4 })
    ).rejects.toThrow('Clipboard text is too large for this paste target.')
  })

  it('yields while measuring large accepted text clipboard IPC reads', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    clipboardReadTextMock.mockReturnValue(text)

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const result = handlers.get('clipboard:readText')?.(makeClipboardEvent(), {
      maxBytes: text.length * 3
    })
    if (!(result instanceof Promise)) {
      throw new Error('Expected clipboard read handler to return a Promise')
    }
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    await vi.runOnlyPendingTimersAsync()
    await expect(result).resolves.toBe(text)
  })

  it('yields before writing large text clipboard IPC payloads', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    clipboardWriteTextMock.mockImplementation((value: string) => {
      clipboardReadTextMock.mockReturnValue(value)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const result = handlers.get('clipboard:writeText')?.(makeClipboardEvent(), text)
    if (!(result instanceof Promise)) {
      throw new Error('Expected clipboard write handler to return a Promise')
    }
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
    await vi.runOnlyPendingTimersAsync()
    await result
    expect(clipboardWriteTextMock).toHaveBeenCalledWith(text)
  })

  it('rejects oversized text clipboard IPC writes before calling Electron clipboard', async () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:writeText')?.(
        makeClipboardEvent(),
        'copied-secret-token-value'.repeat(900_000)
      )
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    await expect(
      handlers.get('clipboard:writeSelectionText')?.(
        makeClipboardEvent(),
        'selection-secret-token-value'.repeat(900_000)
      )
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    expect(clipboardWriteTextMock).not.toHaveBeenCalled()
  })

  it('removes stale clipboard IPC handlers before registering replacements', () => {
    registerClipboardHandlers({} as never)

    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeSelectionText')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeImage')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:writeFile')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:saveImageAsTempFile')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readImageThumbnail')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:hasImage')
    expect(removeHandlerMock).toHaveBeenCalledWith('clipboard:readFilePaths')
  })

  it('does not inspect FileNameW when an empty image clipboard is read outside Windows', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })

    try {
      registerClipboardHandlers({} as never)

      const handler = getRegisteredHandlers().get('clipboard:saveImageAsTempFile')
      await expect(handler?.(makeClipboardEvent(), undefined)).resolves.toBeNull()
      expect(clipboardReadBufferMock).not.toHaveBeenCalled()
      expect(fsOpenMock).not.toHaveBeenCalled()
      expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it.each([false, true])(
    'routes a Windows Explorer image with native format advertised: %s',
    async (advertisesImage) => {
      setTrustedClipboardRendererWebContentsId(17)
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
      clipboardAvailableFormatsMock.mockReturnValue(
        advertisesImage ? ['image/png', 'FileNameW'] : ['FileNameW']
      )
      const sourcePath = 'C:\\Users\\alice\\图片\\copied-image.png'
      const png = Buffer.from([4, 3, 2, 1])
      clipboardReadImageMock.mockReturnValue({ isEmpty: () => true })
      clipboardReadBufferMock.mockImplementation((format: string) =>
        format === 'FileNameW' ? Buffer.from(`${sourcePath}\0`, 'utf16le') : shellIdListArray(1)
      )
      const source = Buffer.alloc(24)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(source)
      source.writeUInt32BE(13, 8)
      source.write('IHDR', 12, 'ascii')
      source.writeUInt32BE(1, 16)
      source.writeUInt32BE(1, 20)
      const close = vi.fn().mockResolvedValue(undefined)
      fsOpenMock.mockResolvedValue({
        close,
        stat: vi.fn().mockResolvedValue({ isFile: () => true, size: source.byteLength }),
        read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
          const bytesRead = Math.min(Math.max(source.byteLength - position, 0), length)
          source.copy(buffer, offset, position, position + bytesRead)
          return { buffer, bytesRead }
        })
      })
      nativeImageCreateFromBufferMock.mockReturnValue({
        getSize: () => ({ height: 1, width: 1 }),
        isEmpty: () => false,
        toPNG: () => png
      })
      try {
        registerClipboardHandlers({} as never)

        const probe = getRegisteredHandlers().get('clipboard:hasImage')
        expect(probe?.(makeClipboardEvent())).toBe(true)
        expect(() => probe?.(makeClipboardEvent({ id: 42 }))).toThrow()
        const handler = getRegisteredHandlers().get('clipboard:saveImageAsTempFile')
        await expect(handler?.(makeClipboardEvent())).resolves.toMatch(
          /orca-paste-1760000000000-00000000-0000-4000-8000-000000000000\.png$/
        )
        expect(clipboardReadBufferMock).toHaveBeenCalledWith('FileNameW')
        expect(clipboardReadBufferMock).toHaveBeenCalledWith('Shell IDList Array')
        expect(fsOpenMock).toHaveBeenCalledWith(sourcePath, 'r')
        expect(nativeImageCreateFromBufferMock).toHaveBeenCalledWith(source)
        expect(close).toHaveBeenCalled()
        expect(fsWriteFileMock).toHaveBeenCalledWith(
          expect.stringMatching(
            /orca-paste-1760000000000-00000000-0000-4000-8000-000000000000\.png$/
          ),
          png
        )
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it('saves clipboard images through the selected remote runtime host', async () => {
    const png = Buffer.alloc(512 * 1024)
    const contentBase64 = png.toString('base64')
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    callRuntimeEnvironmentMock.mockImplementation(async (_userDataPath, _runtimeId, method) => {
      if (method === 'clipboard.startImageUpload') {
        return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'runtime-1' } }
      }
      if (method === 'clipboard.appendImageUploadChunk') {
        return {
          ok: true,
          result: { receivedBase64Length: contentBase64.length },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'clipboard.commitImageUpload') {
        return {
          ok: true,
          result: '/tmp/orca-paste-remote.png',
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        runtimeEnvironmentId: 'remote-host-1'
      })
    ).resolves.toBe('/tmp/orca-paste-remote.png')
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      1,
      '/tmp',
      'remote-host-1',
      'clipboard.startImageUpload',
      { expectedBase64Length: contentBase64.length, connectionId: null },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      2,
      '/tmp',
      'remote-host-1',
      'clipboard.appendImageUploadChunk',
      {
        uploadId: 'upload-1',
        offset: 0,
        contentBase64: contentBase64.slice(0, 512 * 1024)
      },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      3,
      '/tmp',
      'remote-host-1',
      'clipboard.appendImageUploadChunk',
      {
        uploadId: 'upload-1',
        offset: 512 * 1024,
        contentBase64: contentBase64.slice(512 * 1024, 1024 * 1024)
      },
      30_000
    )
    expect(callRuntimeEnvironmentMock).toHaveBeenNthCalledWith(
      4,
      '/tmp',
      'remote-host-1',
      'clipboard.commitImageUpload',
      { uploadId: 'upload-1' },
      30_000
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('aborts remote runtime clipboard image uploads when a chunk fails', async () => {
    const png = Buffer.alloc(512 * 1024)
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => png
    })
    callRuntimeEnvironmentMock.mockImplementation(async (_userDataPath, _runtimeId, method) => {
      if (method === 'clipboard.startImageUpload') {
        return { ok: true, result: { uploadId: 'upload-1' }, _meta: { runtimeId: 'runtime-1' } }
      }
      if (method === 'clipboard.appendImageUploadChunk') {
        return {
          ok: false,
          error: { code: 'runtime_error', message: 'append failed' },
          _meta: { runtimeId: 'runtime-1' }
        }
      }
      if (method === 'clipboard.abortImageUpload') {
        return { ok: true, result: { aborted: true }, _meta: { runtimeId: 'runtime-1' } }
      }
      throw new Error(`unexpected method: ${method}`)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        runtimeEnvironmentId: 'remote-host-1'
      })
    ).rejects.toThrow('append failed')
    expect(callRuntimeEnvironmentMock).toHaveBeenLastCalledWith(
      '/tmp',
      'remote-host-1',
      'clipboard.abortImageUpload',
      { uploadId: 'upload-1' },
      30_000
    )
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('rejects oversized clipboard image dimensions before PNG conversion', async () => {
    const toPNG = vi.fn(() => Buffer.from([0, 1, 2, 3]))
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: CLIPBOARD_IMAGE_MAX_PIXELS + 1 }),
      isEmpty: () => false,
      toPNG
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), undefined)
    ).rejects.toThrow('Clipboard image is too large')
    expect(toPNG).not.toHaveBeenCalled()
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('rejects oversized clipboard PNG bytes before SSH provider lookup', async () => {
    clipboardReadImageMock.mockReturnValue({
      getSize: () => ({ height: 1, width: 1 }),
      isEmpty: () => false,
      toPNG: () => Buffer.alloc(CLIPBOARD_IMAGE_MAX_SOURCE_BYTES + 1)
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await expect(
      handlers.get('clipboard:saveImageAsTempFile')?.(makeClipboardEvent(), {
        connectionId: 'ssh-secret'
      })
    ).rejects.toThrow('Clipboard image is too large')
    expect(fsWriteFileMock).not.toHaveBeenCalled()
  })

  it('ignores oversized clipboard write-image data before decoding base64', () => {
    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    const dataUrl = [
      'data:image/png;base64,',
      'A'.repeat(CLIPBOARD_IMAGE_MAX_BASE64_CHARS + 1)
    ].join('')
    handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), dataUrl)

    expect(nativeImageCreateFromBufferMock).not.toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
  })

  it('ignores clipboard write images with oversized decoded dimensions', async () => {
    nativeImageCreateFromBufferMock.mockReturnValue({
      getSize: () => ({ height: 1, width: CLIPBOARD_IMAGE_MAX_PIXELS + 1 }),
      isEmpty: () => false
    })

    registerClipboardHandlers({} as never)

    const handlers = getRegisteredHandlers()
    await handlers.get('clipboard:writeImage')?.(makeClipboardEvent(), 'data:image/png;base64,AAAA')

    expect(nativeImageCreateFromBufferMock).toHaveBeenCalled()
    expect(clipboardWriteImageMock).not.toHaveBeenCalled()
  })
})
