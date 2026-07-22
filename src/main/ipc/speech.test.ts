import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  fromWebContentsMock,
  getSpeechModelManagerMock,
  getSpeechSttServiceMock,
  getPlaybackSuppressionServiceMock,
  deleteLocalSpeechModelMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getSpeechModelManagerMock: vi.fn(),
  getSpeechSttServiceMock: vi.fn(),
  getPlaybackSuppressionServiceMock: vi.fn(),
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
  getSpeechSttService: getSpeechSttServiceMock,
  getPlaybackSuppressionService: getPlaybackSuppressionServiceMock
}))

vi.mock('../speech/speech-model-deletion', () => ({
  deleteLocalSpeechModel: deleteLocalSpeechModelMock
}))

import { registerSpeechHandlers } from './speech'

type SpeechDownloadHandler = (event: { sender: { id: number } }, modelId: string) => Promise<void>

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
    getPlaybackSuppressionServiceMock.mockReset()
    getPlaybackSuppressionServiceMock.mockReturnValue({
      getCapability: vi.fn(async () => false),
      acquire: vi.fn(),
      release: vi.fn()
    })
    deleteLocalSpeechModelMock.mockReset()
  })

  it('starts stranded mute recovery when speech handlers register', async () => {
    const service = getPlaybackSuppressionServiceMock()

    registerSpeechHandlers({} as never)

    await vi.waitFor(() => expect(service.getCapability).toHaveBeenCalledTimes(1))
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

  it('scopes playback suppression to the renderer and dictation session', async () => {
    const service = {
      getCapability: vi.fn(async () => true),
      acquire: vi.fn(async () => ({ active: true })),
      release: vi.fn(async () => undefined)
    }
    const sender = { id: 7, once: vi.fn() }
    getPlaybackSuppressionServiceMock.mockReturnValue(service)
    registerSpeechHandlers({} as never)

    const capability = getHandler('speech:getPlaybackSuppressionCapability') as unknown as (event: {
      sender: typeof sender
    }) => Promise<boolean>
    const acquire = getHandler('speech:acquirePlaybackSuppression') as unknown as (
      event: { sender: typeof sender },
      sessionId: string
    ) => Promise<{ active: boolean }>
    const release = getHandler('speech:releasePlaybackSuppression') as unknown as (
      event: { sender: typeof sender },
      sessionId: string
    ) => Promise<void>

    await expect(capability({ sender })).resolves.toBe(true)
    await expect(acquire({ sender }, 'session-1')).resolves.toEqual({ active: true })
    await release({ sender }, 'session-1')

    expect(service.acquire).toHaveBeenCalledWith('desktop:7:session-1')
    expect(service.release).toHaveBeenCalledWith('desktop:7:session-1')
  })

  it('releases active playback suppression when its renderer is destroyed', async () => {
    let destroyed: (() => void) | undefined
    const service = {
      getCapability: vi.fn(async () => true),
      acquire: vi.fn(async () => ({ active: true })),
      release: vi.fn(async () => undefined)
    }
    const sender = {
      id: 9,
      once: vi.fn((event: string, listener: () => void) => {
        if (event === 'destroyed') {
          destroyed = listener
        }
      })
    }
    getPlaybackSuppressionServiceMock.mockReturnValue(service)
    registerSpeechHandlers({} as never)
    const acquire = getHandler('speech:acquirePlaybackSuppression') as unknown as (
      event: { sender: typeof sender },
      sessionId: string
    ) => Promise<{ active: boolean }>

    await acquire({ sender }, 'session-2')
    destroyed?.()
    await vi.waitFor(() => expect(service.release).toHaveBeenCalledWith('desktop:9:session-2'))
  })
})
