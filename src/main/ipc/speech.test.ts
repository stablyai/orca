import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  fromWebContentsMock,
  getSpeechModelManagerMock,
  getSpeechSttServiceMock,
  deleteLocalSpeechModelMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getSpeechModelManagerMock: vi.fn(),
  getSpeechSttServiceMock: vi.fn(),
  deleteLocalSpeechModelMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/orca-speech-test') },
  BrowserWindow: { fromWebContents: fromWebContentsMock },
  ipcMain: { handle: handleMock },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(() => Buffer.from('encrypted')),
    isEncryptionAvailable: vi.fn(() => true)
  },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(() => Promise.resolve(true))
  }
}))

vi.mock('../speech/model-catalog', () => ({
  SPEECH_MODEL_CATALOG: [],
  getCatalogModel: vi.fn(() => ({ id: 'model-1' }))
}))

vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: getSpeechModelManagerMock,
  getSpeechSttService: getSpeechSttServiceMock
}))

vi.mock('../speech/speech-model-deletion', () => ({
  deleteLocalSpeechModel: deleteLocalSpeechModelMock
}))

import { registerSpeechHandlers } from './speech'

type SpeechDownloadHandler = (event: { sender: { id: number } }, modelId: string) => Promise<void>

type SpeechDictationHandler = (
  event: { sender: { id: number } },
  modelId: string,
  hotwords?: string[],
  sessionId?: string
) => Promise<void>

/** A window whose real listener bookkeeping can be counted. */
function createDictationWindow(): EventEmitter {
  return Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
}

/** Fetches the handler registered on `channel`, failing loudly if it was never registered. */
function getHandler(channel: string): SpeechDownloadHandler {
  const call = handleMock.mock.calls.find((entry) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1] as SpeechDownloadHandler
}

describe('registerSpeechHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    fromWebContentsMock.mockReset()
    getSpeechModelManagerMock.mockReset()
    getSpeechSttServiceMock.mockReset()
    deleteLocalSpeechModelMock.mockReset()
  })

  it('clears the model download progress callback after completion', async () => {
    const clearProgressCallback = vi.fn()
    const progressCallbacks: ((modelId: string, progress: number) => void)[] = []
    let resolveDownload: () => void = () => {}
    const manager = {
      setProgressCallback: vi.fn((callback: (modelId: string, progress: number) => void) => {
        progressCallbacks.push(callback)
        return clearProgressCallback
      }),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = resolve
          })
      )
    }
    const send = vi.fn()
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send },
      once: vi.fn(),
      off: vi.fn()
    }
    getSpeechModelManagerMock.mockReturnValue(manager)
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)

    const pending = getHandler('speech:downloadModel')({ sender: { id: 7 } }, 'model-1')
    progressCallbacks[0]?.('model-1', 0.5)
    resolveDownload()
    await pending

    expect(send).toHaveBeenCalledWith('speech:downloadProgress', {
      modelId: 'model-1',
      progress: 0.5
    })
    expect(clearProgressCallback).toHaveBeenCalledTimes(1)
    expect(window.off).toHaveBeenCalledWith('closed', expect.any(Function))
  })

  it('clears the model download progress callback when the window closes', async () => {
    const clearProgressCallback = vi.fn()
    let resolveDownload: () => void = () => {}
    const closeHandlers: (() => void)[] = []
    const manager = {
      setProgressCallback: vi.fn(() => clearProgressCallback),
      downloadModel: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDownload = resolve
          })
      )
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn((_event: string, handler: () => void) => {
        closeHandlers.push(handler)
      }),
      off: vi.fn()
    }
    getSpeechModelManagerMock.mockReturnValue(manager)
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)

    const pending = getHandler('speech:downloadModel')({ sender: { id: 7 } }, 'model-1')
    closeHandlers[0]?.()
    resolveDownload()
    await pending

    expect(clearProgressCallback).toHaveBeenCalledTimes(1)
    expect(window.off).toHaveBeenCalledWith('closed', expect.any(Function))
  })

  it('does not stack window closed listeners across per-run dictation sessions', async () => {
    const window = createDictationWindow()
    // Why: a session that never reports stopped/error (worker already gone) is the leak case.
    getSpeechSttServiceMock.mockReturnValue({
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn(async () => undefined)
    })
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)
    const startDictation = getHandler('speech:startDictation') as SpeechDictationHandler

    // DictationController sends a fresh String(runId) per start.
    for (let runId = 1; runId <= 3; runId += 1) {
      await startDictation({ sender: { id: 7 } }, 'model-1', undefined, String(runId))
    }

    expect(window.listenerCount('closed')).toBe(1)
  })

  it('keeps one closed listener per window', async () => {
    const first = createDictationWindow()
    const second = createDictationWindow()
    getSpeechSttServiceMock.mockReturnValue({
      startDictation: vi.fn(async () => undefined),
      stopDictation: vi.fn(async () => undefined)
    })
    fromWebContentsMock.mockImplementation((sender: { id: number }) =>
      sender.id === 7 ? first : second
    )
    registerSpeechHandlers({} as never)
    const startDictation = getHandler('speech:startDictation') as SpeechDictationHandler

    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '1')
    await startDictation({ sender: { id: 8 } }, 'model-1', undefined, '1')
    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '2')

    expect(first.listenerCount('closed')).toBe(1)
    expect(second.listenerCount('closed')).toBe(1)
  })

  it('stops the latest session on window close and tracks a reopened window afresh', async () => {
    const window = createDictationWindow()
    const stopDictation = vi.fn(async () => undefined)
    getSpeechSttServiceMock.mockReturnValue({
      startDictation: vi.fn(async () => undefined),
      stopDictation
    })
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)
    const startDictation = getHandler('speech:startDictation') as SpeechDictationHandler

    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '1')
    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '2')
    window.emit('closed')

    expect(stopDictation).toHaveBeenCalledTimes(1)
    expect(stopDictation).toHaveBeenCalledWith('desktop:7:2')
    expect(window.listenerCount('closed')).toBe(0)

    const reopened = createDictationWindow()
    fromWebContentsMock.mockReturnValue(reopened)
    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '1')

    expect(reopened.listenerCount('closed')).toBe(1)
  })

  it('keeps the live session close listener when a restart fails', async () => {
    const window = createDictationWindow()
    const stopDictation = vi.fn(async () => undefined)
    getSpeechSttServiceMock.mockReturnValue({
      startDictation: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Unknown model: missing')),
      stopDictation
    })
    fromWebContentsMock.mockReturnValue(window)
    registerSpeechHandlers({} as never)
    const startDictation = getHandler('speech:startDictation') as SpeechDictationHandler

    await startDictation({ sender: { id: 7 } }, 'model-1', undefined, '1')
    // A renderer remount resets runId, so the failing restart can reuse session '1'.
    await expect(startDictation({ sender: { id: 7 } }, 'missing', undefined, '1')).rejects.toThrow(
      'Unknown model: missing'
    )

    expect(window.listenerCount('closed')).toBe(1)
    window.emit('closed')
    expect(stopDictation).toHaveBeenCalledWith('desktop:7:1')
  })

  it('routes desktop model deletion through the shared deletion helper', async () => {
    const store = {} as never
    const manager = { deleteModel: vi.fn() }
    const sttService = { prepareModelForDeletion: vi.fn() }
    getSpeechModelManagerMock.mockReturnValue(manager)
    getSpeechSttServiceMock.mockReturnValue(sttService)
    deleteLocalSpeechModelMock.mockResolvedValue(undefined)
    registerSpeechHandlers(store)

    await getHandler('speech:deleteModel')({ sender: { id: 7 } }, 'model-1')

    expect(deleteLocalSpeechModelMock).toHaveBeenCalledWith({
      store,
      modelManager: manager,
      sttService,
      modelId: 'model-1'
    })
  })
})
