import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  fromWebContentsMock,
  getSpeechModelManagerMock,
  getSpeechSttServiceMock,
  deleteLocalSpeechModelMock,
  writeFileMock,
  unlinkMock,
  isTrustedUIRendererMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  getSpeechModelManagerMock: vi.fn(),
  getSpeechSttServiceMock: vi.fn(),
  deleteLocalSpeechModelMock: vi.fn(),
  writeFileMock: vi.fn(),
  unlinkMock: vi.fn(),
  isTrustedUIRendererMock: vi.fn()
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

vi.mock('node:fs/promises', () => ({
  writeFile: writeFileMock,
  unlink: unlinkMock
}))

vi.mock('./ui', () => ({
  isTrustedUIRenderer: isTrustedUIRendererMock
}))

import { registerSpeechHandlers } from './speech'
import { normalizeSpeechHotwords } from '../../shared/speech-hotwords'

type IpcHandler = (event: { sender: { id: number } }, ...args: unknown[]) => Promise<void>

function getHandler(channel: string): IpcHandler {
  const call = handleMock.mock.calls.find((entry) => entry[0] === channel)
  if (!call) {
    throw new Error(`${channel} handler not registered`)
  }
  return call[1] as IpcHandler
}

describe('registerSpeechHandlers', () => {
  beforeEach(() => {
    handleMock.mockReset()
    fromWebContentsMock.mockReset()
    getSpeechModelManagerMock.mockReset()
    getSpeechSttServiceMock.mockReset()
    deleteLocalSpeechModelMock.mockReset()
    writeFileMock.mockReset()
    unlinkMock.mockReset()
    isTrustedUIRendererMock.mockReset()
    isTrustedUIRendererMock.mockReturnValue(true)
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

  it('writes only sanitized hotwords for desktop dictation startup', async () => {
    const sttService = {
      startDictation: vi.fn().mockResolvedValue(undefined),
      stopDictation: vi.fn()
    }
    const window = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
      once: vi.fn(),
      off: vi.fn()
    }
    getSpeechSttServiceMock.mockReturnValue(sttService)
    getSpeechModelManagerMock.mockReturnValue({ getModelsDir: vi.fn(() => '/models') })
    fromWebContentsMock.mockReturnValue(window)
    writeFileMock.mockResolvedValue(undefined)
    unlinkMock.mockResolvedValue(undefined)
    registerSpeechHandlers({} as never)

    await getHandler('speech:startDictation')(
      { sender: { id: 7 } },
      'model-1',
      ['  Orca  ', '', 'orca', 'Example\nbad', 'x'.repeat(121)],
      'session-1'
    )

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/^\/models\/speech-hotwords-/),
      'Orca :2.0\n',
      'utf-8'
    )
    expect(sttService.startDictation).toHaveBeenCalledWith(
      'model-1',
      expect.any(Function),
      expect.stringContaining('speech-hotwords-'),
      'desktop:7:session-1'
    )
  })

  it('rejects privileged speech operations from untrusted renderers', async () => {
    isTrustedUIRendererMock.mockReturnValue(false)
    registerSpeechHandlers({} as never)

    await expect(
      getHandler('speech:deleteModel')({ sender: { id: 7 } }, 'model-1')
    ).rejects.toThrow('Unauthorized speech IPC sender')
    expect(deleteLocalSpeechModelMock).not.toHaveBeenCalled()
  })

  it('normalizes speech hotwords before writing sherpa config files', () => {
    expect(
      normalizeSpeechHotwords(['  Orca  ', '', 'orca', 'Example\nbad', 'x'.repeat(121)])
    ).toEqual(['Orca'])
  })
})
