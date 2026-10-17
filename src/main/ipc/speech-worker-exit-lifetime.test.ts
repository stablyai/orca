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

const fileAccess = vi.hoisted(() => ({ write: vi.fn(), unlink: vi.fn() }))
const cloudFinish = vi.hoisted(() => vi.fn(async () => 'cloud result'))

vi.mock('../speech/openai-transcription-client', () => ({
  OpenAiTranscriptionSession: class {
    finish = cloudFinish
  }
}))

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
    id: 'test-model',
    provider: id === 'cloud-model' ? 'openai' : 'local',
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
import { IDLE_WORKER_TEARDOWN_MS, SttService as SpeechService } from '../speech/stt-service'
import { handleSttWorkerFailure } from '../speech/stt-session-stop'
import { RuntimeMobileDictationController } from '../runtime/runtime-mobile-dictation-controller'

class TestWebContents extends EventEmitter {
  send = vi.fn()
}

class TestWindow extends EventEmitter {
  destroyed = false
  webContents = new TestWebContents()
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
    fileAccess.write.mockReset().mockResolvedValue(undefined)
    fileAccess.unlink.mockReset().mockResolvedValue(undefined)
    cloudFinish.mockClear()
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
    vi.useRealTimers()
  })

  it.each(['render-process-gone', 'destroyed'])(
    'retires an active local owner on %s while keeping the normal warm lifetime',
    async (event) => {
      vi.useFakeTimers()
      const unrelated = vi.fn()
      window.webContents.on(event, unrelated)
      await start('1')
      const current = worker()
      const messages = vi.spyOn(current, 'postMessage')
      const oldSink = service()['state'].eventSink
      window.webContents.send.mockClear()

      window.webContents.emit(event)
      await vi.advanceTimersByTimeAsync(0)

      expect(messages.mock.calls.filter(([message]) => message.type === 'stop')).toHaveLength(1)
      expect(service()['state'].activeOwner).toBeNull()
      expect(service()['state'].eventSink).toBeNull()
      expect(window.listenerCount('closed')).toBe(0)
      expect(window.webContents.listeners(event)).toEqual([unrelated])
      expect(service()['state'].idleTeardownTimer).not.toBeNull()
      oldSink?.({ type: 'final', text: 'abandoned text' })
      oldSink?.({ type: 'error', error: 'late old error' })
      expect(window.webContents.send).not.toHaveBeenCalled()
      window.webContents.emit('destroyed')
      window.emit('closed')
      await vi.advanceTimersByTimeAsync(0)
      expect(messages.mock.calls.filter(([message]) => message.type === 'stop')).toHaveLength(1)

      await service().startDictation('test-model', vi.fn(), undefined, 'mobile:recovered')
      expect(worker()).toBe(current)
      await service().stopDictation('mobile:recovered')
      await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS - 1)
      expect(service().isActive()).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      expect(service().isActive()).toBe(false)
    }
  )

  it('does not let a retired sink cancel a repeated owner while its replacement starts', async () => {
    await start('1')
    const oldWorker = worker()
    oldWorker.emitStoppedOnStop = false
    const oldSink = service()['state'].eventSink
    window.webContents.emit('render-process-gone')
    const replacement = start('1')
    expect(service()['state'].starting).toBe(true)
    oldSink?.({ type: 'error', error: 'late error' })
    oldWorker.emit('message', { type: 'final', text: 'stale final' })
    oldWorker.emit('message', { type: 'stopped' })
    await replacement
    expect(worker()).not.toBe(oldWorker)
    expect(service()['state'].activeOwner).toBe('desktop:9:1')
    expect(service()['state'].canceledOwners.size).toBe(0)
    expect(window.listenerCount('closed')).toBe(1)
    expect(window.webContents.send).not.toHaveBeenCalledWith('speech:final', expect.anything())
    oldSink?.({ type: 'stopped' })
    expect(window.listenerCount('closed')).toBe(1)
    await stop('1')
  })

  it('ignores stale sink capabilities after the same owner accepts another session', async () => {
    await start('1')
    const staleSink = service()['state'].eventSink
    if (!staleSink) {
      throw new Error('Missing accepted sink')
    }
    await stop('1')
    await start('1')
    const current = worker()
    const messages = vi.spyOn(current, 'postMessage')
    await service().retireActiveLocal('desktop:9:1', staleSink)
    await service().retireActiveLocal('desktop:other:1', service()['state'].eventSink ?? vi.fn())
    expect(messages).not.toHaveBeenCalled()
    expect(service()['state'].activeOwner).toBe('desktop:9:1')
    current.emit('message', { type: 'partial', text: 'current text' })
    expect(window.webContents.send).toHaveBeenCalledWith('speech:partial', {
      text: 'current text',
      sessionId: '1'
    })
    await stop('1')
  })

  it('does not retire a startup after a renderer was lost before it settled', async () => {
    environment.readyOnInit = false
    const pending = start('1')
    await Promise.resolve()
    const current = worker()
    const messages = vi.spyOn(current, 'postMessage')
    window.webContents.emit('render-process-gone')
    const startingSink = service()['state'].eventSink
    if (!startingSink) {
      throw new Error('Missing starting sink')
    }
    await service().retireActiveLocal('desktop:9:1', startingSink)
    current.emit('message', { type: 'ready' })
    await pending
    expect(messages).not.toHaveBeenCalled()
    expect(service()['state'].activeOwner).toBe('desktop:9:1')
    expect(window.webContents.send).not.toHaveBeenCalled()
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(window.listenerCount('closed')).toBe(1)
    await stop('1')
  })

  it('does not finish cloud audio on renderer loss or a local retirement request', async () => {
    await handler('speech:startDictation')(sender, 'cloud-model', undefined, 'cloud')
    const sink = service()['state'].eventSink
    if (!sink) {
      throw new Error('Missing cloud sink')
    }
    window.webContents.emit('render-process-gone')
    window.webContents.emit('destroyed')
    await service().retireActiveLocal('desktop:9:cloud', sink)
    expect(cloudFinish).not.toHaveBeenCalled()
    expect(service()['state'].activeOwner).toBe('desktop:9:cloud')
    await stop('cloud')
    expect(cloudFinish).toHaveBeenCalledTimes(1)
  })

  it.each(['error', 'exit', 'timeout'])(
    'releases a lost owner when its stop ends with %s',
    async (outcome) => {
      vi.useFakeTimers()
      await start()
      const current = worker()
      current.emitStoppedOnStop = false
      window.webContents.send.mockClear()
      window.webContents.emit('render-process-gone')
      if (outcome === 'error') {
        current.emit('error', new Error('stop failed'))
      }
      if (outcome === 'exit') {
        current.emit('exit', 1)
      }
      await vi.advanceTimersByTimeAsync(outcome === 'timeout' ? 60_000 : 0)
      expect(service()['state'].activeOwner).toBeNull()
      expect(service().isActive()).toBe(false)
      expect(window.webContents.send).not.toHaveBeenCalled()
      await start('recovered')
      await stop('recovered')
    }
  )

  it('keeps a live local session through navigation and delivers final text before stopped', async () => {
    await start()
    window.webContents.emit('did-start-loading')
    expect(service()['state'].activeOwner).toBe('desktop:9:one')
    worker().emit('message', { type: 'final', text: 'keep this' })
    await stop()
    expect(window.webContents.send.mock.calls.slice(-2)).toEqual([
      ['speech:final', { text: 'keep this', sessionId: 'one' }],
      ['speech:stopped', { sessionId: 'one' }]
    ])
    expect(window.webContents.listenerCount('render-process-gone')).toBe(0)
    expect(window.webContents.listenerCount('destroyed')).toBe(0)
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
