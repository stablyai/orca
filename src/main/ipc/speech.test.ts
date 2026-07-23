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

import {
  clearSpeechIpcAdmissionForTests,
  getActiveDesktopDictationListenerCountForTest,
  getPendingDesktopDictationStartCountForTest,
  registerSpeechHandlers
} from './speech'
import {
  MAX_PENDING_DESKTOP_DICTATION_STARTS,
  MAX_SPEECH_AUDIO_CHUNK_BYTES,
  MAX_SPEECH_HOTWORD_BYTES,
  MAX_SPEECH_HOTWORDS,
  MAX_SPEECH_SESSION_ID_BYTES
} from './speech-ipc-admission'

type SpeechDownloadHandler = (event: { sender: { id: number } }, modelId: string) => Promise<void>

function getHandler<T = SpeechDownloadHandler>(channel: string): T {
  const call = handleMock.mock.calls.find((entry) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1] as T
}

type SpeechFeedHandler = (
  event: { sender: { id: number } },
  buffer: Uint8Array,
  sampleRate: number,
  sessionId?: string
) => Promise<void>

type SpeechStartHandler = (
  event: { sender: { id: number } },
  modelId: string,
  hotwords?: string[],
  sessionId?: string
) => Promise<void>

type SpeechStopHandler = (event: { sender: { id: number } }, sessionId?: string) => Promise<void>

describe('registerSpeechHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    fromWebContentsMock.mockReset()
    getSpeechModelManagerMock.mockReset()
    getSpeechSttServiceMock.mockReset()
    deleteLocalSpeechModelMock.mockReset()
    clearSpeechIpcAdmissionForTests()
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

  it('rejects oversized or malformed audio chunks before reaching the STT service', async () => {
    const feedAudio = vi.fn()
    getSpeechSttServiceMock.mockReturnValue({ feedAudio })
    registerSpeechHandlers({} as never)
    const handler = getHandler<SpeechFeedHandler>('speech:feedAudio')

    await expect(
      handler(
        { sender: { id: 7 } },
        new Uint8Array(MAX_SPEECH_AUDIO_CHUNK_BYTES + 4),
        48_000,
        'session'
      )
    ).rejects.toThrow('Invalid speech audio chunk')
    await expect(
      handler({ sender: { id: 7 } }, new Uint8Array(3), 48_000, 'session')
    ).rejects.toThrow('Invalid speech audio chunk')
    expect(feedAudio).not.toHaveBeenCalled()
  })

  it('copies an admitted audio view into an exact-size transferable buffer', async () => {
    const feedAudio = vi.fn()
    getSpeechSttServiceMock.mockReturnValue({ feedAudio })
    registerSpeechHandlers({} as never)
    const handler = getHandler<SpeechFeedHandler>('speech:feedAudio')
    const oversizedBacking = new Uint8Array(MAX_SPEECH_AUDIO_CHUNK_BYTES + 128)
    const admittedView = oversizedBacking.subarray(64, 64 + MAX_SPEECH_AUDIO_CHUNK_BYTES)

    await handler({ sender: { id: 8 } }, admittedView, 48_000, 'session')

    const samples = feedAudio.mock.calls[0]?.[0] as Float32Array
    expect(samples.byteLength).toBe(MAX_SPEECH_AUDIO_CHUNK_BYTES)
    expect(samples.buffer.byteLength).toBe(MAX_SPEECH_AUDIO_CHUNK_BYTES)
    expect(feedAudio).toHaveBeenCalledWith(samples, 48_000, 'desktop:8:session')
  })

  it.each([
    ['count', Array.from({ length: MAX_SPEECH_HOTWORDS + 1 }, () => 'word')],
    ['per-word bytes', ['😀'.repeat(Math.floor(MAX_SPEECH_HOTWORD_BYTES / 4) + 1)]],
    ['aggregate bytes', Array.from({ length: 64 }, () => 'x'.repeat(MAX_SPEECH_HOTWORD_BYTES))]
  ])('rejects hotword %s overflow before window or service retention', async (_label, hotwords) => {
    registerSpeechHandlers({} as never)
    const handler = getHandler<SpeechStartHandler>('speech:startDictation')

    await expect(handler({ sender: { id: 9 } }, 'model-1', hotwords, 'session')).rejects.toThrow(
      /hotword/i
    )
    expect(fromWebContentsMock).not.toHaveBeenCalled()
    expect(getSpeechSttServiceMock).not.toHaveBeenCalled()
  })

  it('rejects oversized session ids for start, feed, and stop before service work', async () => {
    registerSpeechHandlers({} as never)
    const oversizedSession = '😀'.repeat(Math.floor(MAX_SPEECH_SESSION_ID_BYTES / 4) + 1)

    await expect(
      getHandler<SpeechStartHandler>('speech:startDictation')(
        { sender: { id: 10 } },
        'model-1',
        undefined,
        oversizedSession
      )
    ).rejects.toThrow('Invalid speech session id')
    await expect(
      getHandler<SpeechFeedHandler>('speech:feedAudio')(
        { sender: { id: 10 } },
        new Uint8Array(4),
        16_000,
        oversizedSession
      )
    ).rejects.toThrow('Invalid speech session id')
    await expect(
      getHandler<SpeechStopHandler>('speech:stopDictation')(
        { sender: { id: 10 } },
        oversizedSession
      )
    ).rejects.toThrow('Invalid speech session id')
    expect(getSpeechSttServiceMock).not.toHaveBeenCalled()
  })

  it('caps concurrent desktop dictation starts and releases admission after settlement', async () => {
    let resolveStarts = (): void => {}
    const startGate = new Promise<void>((resolve) => {
      resolveStarts = resolve
    })
    const startDictation = vi.fn(() => startGate)
    getSpeechSttServiceMock.mockReturnValue({ startDictation, stopDictation: vi.fn() })
    fromWebContentsMock.mockImplementation((sender: { id: number }) => ({
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn(),
      off: vi.fn(),
      sender
    }))
    registerSpeechHandlers({} as never)
    const handler = getHandler<SpeechStartHandler>('speech:startDictation')
    const starts = Array.from({ length: MAX_PENDING_DESKTOP_DICTATION_STARTS }, (_, index) =>
      handler({ sender: { id: 100 + index } }, 'model-1', undefined, 'session')
    )

    await vi.waitFor(() =>
      expect(getPendingDesktopDictationStartCountForTest()).toBe(
        MAX_PENDING_DESKTOP_DICTATION_STARTS
      )
    )
    await expect(handler({ sender: { id: 999 } }, 'model-1', undefined, 'session')).rejects.toThrow(
      'Too many pending speech dictation starts'
    )
    resolveStarts()
    await Promise.all(starts)

    expect(startDictation).toHaveBeenCalledTimes(MAX_PENDING_DESKTOP_DICTATION_STARTS)
    expect(getPendingDesktopDictationStartCountForTest()).toBe(0)
  })

  it('replaces the retained window listener for a sequential same-owner restart', async () => {
    const stopDictation = vi.fn().mockResolvedValue(undefined)
    getSpeechSttServiceMock.mockReturnValue({
      startDictation: vi.fn().mockResolvedValue(undefined),
      stopDictation
    })
    const firstWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn(),
      off: vi.fn()
    }
    const secondWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn(),
      off: vi.fn()
    }
    fromWebContentsMock.mockReturnValueOnce(firstWindow).mockReturnValueOnce(secondWindow)
    registerSpeechHandlers({} as never)
    const start = getHandler<SpeechStartHandler>('speech:startDictation')

    await start({ sender: { id: 200 } }, 'model-1', undefined, 'session')
    await start({ sender: { id: 200 } }, 'model-1', undefined, 'session')

    expect(getActiveDesktopDictationListenerCountForTest()).toBe(1)
    expect(firstWindow.off).toHaveBeenCalledWith('closed', expect.any(Function))
    await getHandler<SpeechStopHandler>('speech:stopDictation')({ sender: { id: 200 } }, 'session')
    expect(secondWindow.off).toHaveBeenCalledWith('closed', expect.any(Function))
    expect(getActiveDesktopDictationListenerCountForTest()).toBe(0)
  })
})
