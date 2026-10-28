import { EventEmitter } from 'node:events'
import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { ModelManager } from '../speech/model-manager'
import type { SttService } from '../speech/stt-service'
import type { RuntimeStore } from '../runtime/runtime-store-contract'

type SpeechHandler = (
  event: { sender: { id: number } },
  modelOrSession: string,
  hotwords?: string[],
  sessionId?: string
) => Promise<void>

type TestWorker = EventEmitter & {
  emitStoppedOnStop: boolean
  postMessage: (message: { type: string }) => void
}

const environment = vi.hoisted(
  (): {
    handlers: Map<string, SpeechHandler>
    window: TestWindow | null
    service: SttService | null
    workers: TestWorker[]
    readyOnInit: boolean
  } => ({
    handlers: new Map<string, SpeechHandler>(),
    window: null,
    service: null,
    workers: [],
    readyOnInit: true
  })
)

const finishUploads: (() => void)[] = []

const fileAccess = vi.hoisted(() => ({ write: vi.fn(), unlink: vi.fn() }))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  writeFile: fileAccess.write,
  unlink: fileAccess.unlink
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: SpeechHandler) => environment.handlers.set(name, callback)
  },
  BrowserWindow: { fromWebContents: () => environment.window },
  systemPreferences: {
    getMediaAccessStatus: () => 'granted',
    askForMediaAccess: async () => true
  }
}))
vi.mock('../speech/speech-runtime-service', () => ({
  getSpeechModelManager: () => ({
    getModelState: async () => ({ status: 'ready' }),
    getModelsDir: () => 'unused-models'
  }),
  getSpeechSttService: () => environment.service
}))
vi.mock('../speech/openai-api-key-store', () => ({
  readOpenAiSpeechApiKey: vi.fn(),
  clearOpenAiSpeechApiKey: vi.fn(),
  hasOpenAiSpeechApiKey: () => false,
  saveOpenAiSpeechApiKey: vi.fn()
}))
vi.mock('../speech/model-catalog', () => ({
  SPEECH_MODEL_CATALOG: [],
  getCatalogModel: (id: string) => ({
    id,
    provider: id === 'openai-gpt-4o-mini-transcribe' ? 'openai' : 'local',
    type: 'transducer',
    streaming: true,
    sampleRate: 16000,
    files: []
  }),
  isLocalSpeechModel: () => true
}))
vi.mock('../speech/stt-worker-paths', () => ({
  LOCAL_SPEECH_UNAVAILABLE_ERROR: 'voice_model_not_ready:unavailable',
  getSttWorkerPath: () => 'unused-worker',
  getSherpaModulePath: () => 'unused-module',
  hasLocalSpeechRecognizer: () => true
}))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter: WorkerEvents } = await import('node:events')
  return {
    Worker: class extends WorkerEvents implements TestWorker {
      emitStoppedOnStop = true
      constructor() {
        super()
        environment.workers.push(this)
      }
      postMessage(message: { type: string }): void {
        if (message.type === 'init' && environment.readyOnInit) {
          queueMicrotask(() => this.emit('message', { type: 'ready' }))
        }
        if (message.type === 'stop' && this.emitStoppedOnStop) {
          queueMicrotask(() => this.emit('message', { type: 'stopped' }))
        }
      }
      async terminate(): Promise<number> {
        this.emit('exit', 0)
        return 0
      }
    }
  }
})

import { registerSpeechHandlers } from './speech'
import { SttService as SpeechService } from '../speech/stt-service'
import { handleSttWorkerFailure } from '../speech/stt-session-stop'
import { RuntimeMobileDictationController } from '../runtime/runtime-mobile-dictation-controller'

class TestContents extends EventEmitter {
  id = 9
  send = vi.fn()
  isDestroyed(): boolean {
    return false
  }
}

class TestWindow extends EventEmitter {
  destroyed = false
  webContents = new TestContents()
  isDestroyed(): boolean {
    return this.destroyed
  }
}

function handler(name: string): SpeechHandler {
  const callback = environment.handlers.get(name)
  if (!callback) {
    throw new Error(`Missing handler: ${name}`)
  }
  return callback
}

function worker(): TestWorker {
  const current = environment.workers.at(-1)
  if (!current) {
    throw new Error('No worker created')
  }
  return current
}

function service(): SttService {
  if (!environment.service) {
    throw new Error('No service created')
  }
  return environment.service
}

const sender = {
  get sender(): TestContents {
    if (!environment.window) {
      throw new Error('No window')
    }
    return environment.window.webContents
  }
}
const start = (session = 'one'): Promise<void> =>
  handler('speech:startDictation')(sender, 'test-model', undefined, session)
const stop = (session = 'one'): Promise<void> => handler('speech:stopDictation')(sender, session)

describe('speech worker exit ownership', () => {
  it('discards retired cloud audio without uploading and accepts a replacement owner', async () => {
    const upload = vi.fn()
    vi.stubGlobal('fetch', upload)
    await handler('speech:startDictation')(sender, 'openai-gpt-4o-mini-transcribe', undefined, '2')
    service().feedAudio(new Float32Array(16000), 16000, 'desktop:9:0:2')
    window.webContents.send.mockClear()
    window.webContents.emit('render-process-gone')
    expect(upload).not.toHaveBeenCalled()
    expect(service()['state'].activeOwner).toBeNull()
    expect(service()['state'].cloudSession).toBeNull()
    expect(service()['state'].eventSink).toBeNull()
    expect(window.webContents.send).not.toHaveBeenCalled()
    await start('1')
    expect(service()['state'].activeOwner).toBe('desktop:9:1:1')
    await stop('1')
  })

  it('aborts an uploading retired owner and fences late completion from its successor', async () => {
    const response = Promise.withResolvers<Response>()
    finishUploads.push(() => response.resolve(new Response(JSON.stringify({ text: 'cleanup' }))))
    const uploads: RequestInit[] = []
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      uploads.push(init)
      return response.promise
    })
    await handler('speech:startDictation')(sender, 'openai-gpt-4o-mini-transcribe', undefined, '2')
    service().feedAudio(new Float32Array(16000), 16000, 'desktop:9:0:2')
    const pendingStop = stop('2')
    expect(uploads.at(-1)?.signal?.aborted).toBe(false)
    window.webContents.emit('did-navigate')
    expect(uploads.at(-1)?.signal?.aborted).toBe(true)
    await start('1')
    window.webContents.send.mockClear()
    response.resolve(new Response(JSON.stringify({ text: 'obsolete text' })))
    await pendingStop
    expect(service()['state'].activeOwner).toBe('desktop:9:1:1')
    expect(service()['state'].eventSink).not.toBeNull()
    expect(window.webContents.send).not.toHaveBeenCalled()
    worker().emit('message', { type: 'partial', text: 'replacement text' })
    expect(window.webContents.send).toHaveBeenCalledWith('speech:partial', {
      text: 'replacement text',
      sessionId: '1'
    })
    await stop('1')
  })

  it('coalesces explicit cloud stop and keeps its owner until final text is delivered', async () => {
    const response = Promise.withResolvers<Response>()
    finishUploads.push(() => response.resolve(new Response(JSON.stringify({ text: 'cleanup' }))))
    const upload = vi.fn(() => response.promise)
    vi.stubGlobal('fetch', upload)
    await handler('speech:startDictation')(sender, 'openai-gpt-4o-mini-transcribe', undefined, '2')
    service().feedAudio(new Float32Array(16000), 16000, 'desktop:9:0:2')
    const firstStop = stop('2')
    const secondStop = stop('2')
    await expect(start('1')).rejects.toThrow('dictation_already_active')
    expect(service()['state'].activeOwner).toBe('desktop:9:0:2')
    response.resolve(new Response(JSON.stringify({ text: 'completed text' })))
    await Promise.all([firstStop, secondStop])
    expect(upload).toHaveBeenCalledTimes(1)
    expect(window.webContents.send.mock.calls.filter(([name]) => name === 'speech:final')).toEqual([
      ['speech:final', { text: 'completed text', sessionId: '2' }]
    ])
    expect(service()['state'].activeOwner).toBeNull()
    expect(service()['state'].eventSink).toBeNull()
  })

  it('fences a late worker ready result after renderer document retirement', async () => {
    environment.readyOnInit = false
    const pending = start('2')
    await vi.waitFor(() => expect(environment.workers).toHaveLength(1))
    window.webContents.send.mockClear()
    window.webContents.emit('render-process-gone')
    worker().emit('message', { type: 'ready' })
    await expect(pending).rejects.toThrow('dictation_canceled')
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(service()['state'].activeOwner).toBeNull()
    expect(service()['state'].eventSink).toBeNull()
  })

  it('does not let a successor document join a retired pending start with the same run id', async () => {
    environment.readyOnInit = false
    const retired = start('1')
    await vi.waitFor(() => expect(environment.workers).toHaveLength(1))
    window.webContents.emit('did-navigate')
    await expect(start('1')).rejects.toThrow('dictation_already_active')
    worker().emit('message', { type: 'ready' })
    await expect(retired).rejects.toThrow('dictation_canceled')
    window.webContents.send.mockClear()
    await start('1')
    expect(window.webContents.send).toHaveBeenCalledWith('speech:ready', { sessionId: '1' })
    expect(service()['state'].activeOwner).toBe('desktop:9:1:1')
    await stop('1')
  })

  it('preserves same-document dictation and bounds native listeners across replacements', async () => {
    for (let index = 0; index < 10; index++) {
      await start(String(index))
      window.webContents.emit('did-navigate-in-page', {}, '#section', true)
      expect(service()['state'].activeOwner).toBe(`desktop:9:${index}:${index}`)
      expect(window.webContents.listenerCount('did-navigate')).toBe(1)
      window.webContents.emit(index % 2 === 0 ? 'render-process-gone' : 'did-navigate')
      await vi.waitFor(() => expect(service()['state'].activeOwner).toBeNull())
      expect(window.webContents.eventNames()).toEqual([])
      expect(window.listenerCount('closed')).toBe(0)
    }
    expect(environment.workers).toHaveLength(1)
  })

  it('keeps a successor hotwords file until its worker has read it', async () => {
    environment.readyOnInit = false
    const write = Promise.withResolvers<void>()
    fileAccess.write.mockReturnValueOnce(write.promise)
    const retired = handler('speech:startDictation')(sender, 'test-model', ['orca'], '2')
    window.webContents.emit('render-process-gone')
    const replacement = handler('speech:startDictation')(sender, 'test-model', ['orca'], '1')
    await vi.waitFor(() => expect(environment.workers).toHaveLength(1))
    write.resolve()
    const retirementError = await retired.then(
      () => undefined,
      (error: Error) => error.message
    )
    const deletesBeforeReady = fileAccess.unlink.mock.calls.length
    worker().emit('message', { type: 'ready' })
    await replacement
    await stop('1')
    expect(retirementError).toBeUndefined()
    expect(deletesBeforeReady).toBe(0)
  })

  it.each(['render-process-gone', 'did-navigate'])(
    'releases renderer document dictation on %s and allows a replacement',
    async (event) => {
      await start('2')
      const state = service()['state']
      const originalWorker = worker()
      expect(state.activeOwner).toBe('desktop:9:0:2')
      window.webContents.send.mockClear()
      window.webContents.emit(event)
      originalWorker.emit('message', { type: 'partial', text: 'retired text' })
      await Promise.resolve()
      await Promise.resolve()
      expect(state.activeOwner).toBeNull()
      expect(state.eventSink).toBeNull()
      expect(window.webContents.send).not.toHaveBeenCalled()
      await start('1')
      expect(state.activeOwner).toBe('desktop:9:1:1')
      expect(worker()).toBe(originalWorker)
      await stop('1')
    }
  )

  it('prevents renderer document hotword preparation from starting after retirement', async () => {
    const write = Promise.withResolvers<void>()
    fileAccess.write.mockReturnValueOnce(write.promise)
    const pending = handler('speech:startDictation')(sender, 'test-model', ['orca'], '2')
    window.webContents.emit('render-process-gone')
    write.resolve()
    await pending
    expect(environment.workers).toHaveLength(0)
    expect(service()['state'].activeOwner).toBeNull()
    expect(window.webContents.send).not.toHaveBeenCalled()
  })

  let window: TestWindow
  beforeEach(() => {
    environment.handlers.clear()
    environment.workers = []
    environment.readyOnInit = true
    fileAccess.write.mockReset().mockResolvedValue(undefined)
    fileAccess.unlink.mockReset().mockResolvedValue(undefined)
    window = new TestWindow()
    environment.window = window
    const modelManager: Pick<ModelManager, 'getModelState' | 'getModelDir'> = {
      getModelState: async () => ({ id: 'test-model', status: 'ready' as const }),
      getModelDir: () => 'unused-model'
    }
    environment.service = new SpeechService(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Local startup reads only these two model-manager methods.
      modelManager as ModelManager
    )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Mocked runtime accessors do not read the store.
    registerSpeechHandlers({} as Store)
  })
  afterEach(async () => {
    for (const finish of finishUploads.splice(0)) {
      finish()
    }
    window.destroyed = true
    window.emit('closed')
    await Promise.resolve()
    await Promise.resolve()
    await vi.waitFor(() => expect(service()['state'].activeOwner).toBeNull())
    await service().prepareModelForDeletion('test-model')
    vi.unstubAllGlobals()
  })

  it('bounds close listeners through repeated starts and stops with no remaining worker', async () => {
    const unrelated = vi.fn()
    window.on('closed', unrelated)
    const counts: number[] = []
    for (let cycle = 0; cycle < 12; cycle += 1) {
      const session = String(cycle)
      await start(session)
      await start(session)
      await stop(session)
      worker().emit('exit', 0)
      expect(service().isActive()).toBe(false)
      await stop(session)
      counts.push(window.listenerCount('closed'))
    }
    expect(counts).toEqual(Array.from({ length: 12 }, () => 1))
    expect(window.listeners('closed')).toEqual([unrelated])
  })

  it('cleans a completed stop when the service has no worker and sends no report', async () => {
    await start()
    handleSttWorkerFailure(service()['state'])
    expect(service().isActive()).toBe(false)
    expect(window.listenerCount('closed')).toBe(1)
    await stop()
    expect(window.listenerCount('closed')).toBe(0)
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(0)
  })

  it('keeps the accepted startup hook when a same-owner start is coalesced', async () => {
    environment.readyOnInit = false
    const pendingStart = start()
    await Promise.resolve()
    await start()
    expect(window.listenerCount('closed')).toBe(1)
    worker().emit('message', { type: 'ready' })
    await pendingStart
    worker().emit('exit', 0)
    expect(window.listenerCount('closed')).toBe(0)
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(1)
  })

  it('keeps the live hook after a rejected owner and lets window close stop it', async () => {
    await start('live')
    await expect(start('rejected')).rejects.toThrow('dictation_already_active')
    expect(window.listenerCount('closed')).toBe(1)
    window.destroyed = true
    window.emit('closed')
    await vi.waitFor(() => expect(service()['state'].activeOwner).toBeNull())
    expect(window.listenerCount('closed')).toBe(0)
    expect(service()['state'].eventSink).toBeNull()
  })

  it('preserves the active hook when another owner cannot stop it', async () => {
    await start('live')
    await expect(stop('other')).rejects.toThrow('dictation_owner_mismatch')
    expect(window.listenerCount('closed')).toBe(1)
    await stop('live')
    expect(window.listenerCount('closed')).toBe(0)
  })

  it('does not let a delayed old stop remove the replacement hook', async () => {
    await start('old')
    const { promise, resolve } = Promise.withResolvers<void>()
    const originalStop = service().stopDictation.bind(service())
    vi.spyOn(service(), 'stopDictation').mockImplementation(async (owner, options) => {
      await originalStop(owner, options)
      await promise
    })
    const pendingStop = stop('old')
    await vi.waitFor(() => expect(window.listenerCount('closed')).toBe(0))
    await start('replacement')
    expect(window.listenerCount('closed')).toBe(1)
    resolve()
    await pendingStop
    expect(window.listenerCount('closed')).toBe(1)
    await stop('replacement')
    expect(window.listenerCount('closed')).toBe(0)
  })

  it('retains hotwords until startup finishes and preserves the live hook on write failure', async () => {
    environment.readyOnInit = false
    const pendingStart = handler('speech:startDictation')(sender, 'test-model', ['orca'], 'one')
    await vi.waitFor(() => expect(environment.workers).toHaveLength(1))
    expect(fileAccess.write).toHaveBeenCalledTimes(1)
    expect(fileAccess.unlink).not.toHaveBeenCalled()
    worker().emit('message', { type: 'ready' })
    await pendingStart
    expect(fileAccess.unlink).toHaveBeenCalledTimes(1)
    fileAccess.write.mockRejectedValueOnce(new Error('write failed'))
    await expect(
      handler('speech:startDictation')(sender, 'test-model', ['different'], 'two')
    ).rejects.toThrow('write failed')
    expect(window.listenerCount('closed')).toBe(1)
    expect(fileAccess.unlink).toHaveBeenCalledTimes(1)
    await stop()
    expect(window.listenerCount('closed')).toBe(0)
  })

  it.each([0, 1])('releases the window listener after unexpected exit code %i', async (code) => {
    for (let cycle = 0; cycle < 15; cycle++) {
      await start(String(cycle))
      expect(window.listenerCount('closed')).toBe(1)
      const current = worker()
      current.emit('exit', code)
      expect(service().isActive()).toBe(false)
      expect(window.listenerCount('closed')).toBe(0)
      expect(current.listenerCount('message')).toBe(0)
      expect(current.listenerCount('error')).toBe(0)
      expect(current.listenerCount('exit')).toBe(0)
      await stop(String(cycle))
    }
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(15)
  })

  it('does not duplicate the in-flight stop notification', async () => {
    await start()
    worker().emitStoppedOnStop = false
    const pendingStop = stop()
    worker().emit('exit', 1)
    await pendingStop
    expect(window.listenerCount('closed')).toBe(0)
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(1)
  })

  it('keeps a normal stop reusable and ignores a later idle-worker exit', async () => {
    await start()
    const current = worker()
    await stop()
    expect(window.listenerCount('closed')).toBe(0)
    await start('two')
    expect(worker()).toBe(current)
    await stop('two')
    current.emit('exit', 0)
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(2)
  })

  it('cleans a failed startup and allows a new session', async () => {
    environment.readyOnInit = false
    const pendingStart = start()
    const rejected = expect(pendingStart).rejects.toThrow('Speech worker exited before ready: 1')
    await Promise.resolve()
    worker().emit('exit', 1)
    await rejected
    expect(window.listenerCount('closed')).toBe(0)
    environment.readyOnInit = true
    await start('two')
    expect(service().isActive()).toBe(true)
    await stop('two')
  })

  it('preserves error delivery and listener cleanup', async () => {
    await start()
    const current = worker()
    current.emit('error', new Error('synthetic failure'))
    await vi.waitFor(() => expect(window.listenerCount('closed')).toBe(0))
    expect(window.webContents.send).toHaveBeenCalledWith('speech:error', {
      error: 'Error: synthetic failure',
      sessionId: 'one'
    })
    current.emit('exit', 1)
    expect(service().isActive()).toBe(false)
  })

  it('preserves startup cancellation without duplicate stopped events', async () => {
    environment.readyOnInit = false
    const pendingStart = start()
    const rejected = expect(pendingStart).rejects.toThrow('Speech worker exited before ready: 1')
    await Promise.resolve()
    worker().emitStoppedOnStop = false
    const pendingStop = stop()
    worker().emit('exit', 1)
    await Promise.all([pendingStop, rejected])
    expect(window.listenerCount('closed')).toBe(0)
    expect(
      window.webContents.send.mock.calls.filter(([name]) => name === 'speech:stopped')
    ).toHaveLength(1)
  })

  it('preserves mobile partial text and completion after worker exit', async () => {
    const store = { getSettings: () => ({ voice: { enabled: true, sttModel: 'test-model' } }) }
    const controller = new RuntimeMobileDictationController(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The controller reads settings; mocked speech accessors ignore the rest of the store.
      () => store as RuntimeStore
    )
    const params = { dictationId: 'mobile', clientId: 'client', connectionId: 'connection' }
    await controller.start(params)
    worker().emit('message', { type: 'partial', text: 'keep these words' })
    worker().emit('exit', 0)
    await expect(controller.finish(params)).resolves.toEqual({
      dictationId: 'mobile',
      text: 'keep these words'
    })
    expect(service().isActive()).toBe(false)
  })

  it('clears old ownership before notifying a sink that immediately starts again', async () => {
    let restarted: Promise<void> | undefined
    await service().startDictation(
      'test-model',
      (event) => {
        if (event.type === 'stopped') {
          restarted = service().startDictation('test-model', vi.fn(), undefined, 'replacement')
        }
      },
      undefined,
      'original'
    )
    const retired = worker()
    retired.emit('exit', 0)
    expect(restarted).toBeDefined()
    await restarted
    expect(worker()).not.toBe(retired)
    retired.emit('exit', 0)
    retired.emit('message', { type: 'stopped' })
    expect(service().isActive()).toBe(true)
    await service().stopDictation('replacement')
  })
})
