import { EventEmitter } from 'node:events'
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
  getSpeechModelManager: () => ({ getModelState: async () => ({ status: 'ready' }) }),
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
  getCatalogModel: () => ({
    id: 'test-model',
    provider: 'local',
    type: 'transducer',
    streaming: true,
    sampleRate: 16000,
    files: []
  })
}))
vi.mock('../speech/stt-worker-paths', () => ({
  getSttWorkerPath: () => 'unused-worker',
  getSherpaModulePath: () => 'unused-module'
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
import { RuntimeMobileDictationController } from '../runtime/runtime-mobile-dictation-controller'

class TestWindow extends EventEmitter {
  destroyed = false
  webContents = { send: vi.fn() }
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

const sender = { sender: { id: 9 } }
const start = (session = 'one'): Promise<void> =>
  handler('speech:startDictation')(sender, 'test-model', undefined, session)
const stop = (session = 'one'): Promise<void> => handler('speech:stopDictation')(sender, session)

describe('speech worker exit ownership', () => {
  let window: TestWindow
  beforeEach(() => {
    environment.handlers.clear()
    environment.workers = []
    environment.readyOnInit = true
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
    window.destroyed = true
    window.emit('closed')
    await Promise.resolve()
    await Promise.resolve()
    await service().prepareModelForDeletion('test-model')
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
