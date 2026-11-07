import type { ModelManager } from './model-manager'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  MockOpenAiTranscriptionSession,
  MockWorker,
  getCloudSessions,
  getCreatedWorkerCount,
  getLastWorker,
  readOpenAiSpeechApiKeyMock,
  resetCloudSessions,
  resetWorkers
} = vi.hoisted(() => {
  class HoistedMockWorker extends EventTarget {
    static created = 0
    static instances: HoistedMockWorker[] = []
    static emitReadyOnInit = true
    terminated = false
    emitStoppedOnStop = true
    answerDiscard = true
    emitReadyOnInit = HoistedMockWorker.emitReadyOnInit
    emitExitOnTerminate = true
    terminatePromise: Promise<number> | null = null
    messages: WorkerMessage[] = []
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

    constructor() {
      super()
      HoistedMockWorker.created += 1
      HoistedMockWorker.instances.push(this)
    }

    on(eventName: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(eventName) ?? new Set()
      listeners.add(listener)
      this.listeners.set(eventName, listeners)
      return this
    }

    off(eventName: string, listener: (...args: unknown[]) => void): this {
      this.listeners.get(eventName)?.delete(listener)
      return this
    }

    listenerCount(eventName: string): number {
      return this.listeners.get(eventName)?.size ?? 0
    }

    removeAllListeners(): this {
      this.listeners.clear()
      return this
    }

    emit(eventName: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(eventName) ?? []) {
        listener(...args)
      }
    }

    postMessage(message: WorkerMessage): void {
      this.messages.push(message)
      if (message.type === 'init' && this.emitReadyOnInit) {
        queueMicrotask(() => this.emit('message', { type: 'ready' }))
      }
      if (
        (message.type === 'stop' && this.emitStoppedOnStop) ||
        (message.type === 'discard' && this.answerDiscard)
      ) {
        queueMicrotask(() => this.emit('message', { type: 'stopped', streamId: message.streamId }))
      }
    }

    terminate(): Promise<number> {
      this.terminated = true
      if (this.emitExitOnTerminate) {
        this.emit('exit', 0)
      }
      return this.terminatePromise ?? Promise.resolve(0)
    }
  }

  class HoistedMockOpenAiTranscriptionSession {
    static instances: HoistedMockOpenAiTranscriptionSession[] = []
    feedCalls: { samples: Float32Array; sampleRate: number }[] = []

    constructor(
      readonly modelId: string,
      readonly readApiKey: () => string
    ) {
      HoistedMockOpenAiTranscriptionSession.instances.push(this)
    }

    feedAudio(samples: Float32Array, sampleRate: number): void {
      this.feedCalls.push({ samples, sampleRate })
    }

    finish(): Promise<string> {
      return Promise.resolve(`${this.modelId}:${this.readApiKey()}`)
    }
  }

  return {
    MockOpenAiTranscriptionSession: HoistedMockOpenAiTranscriptionSession,
    MockWorker: HoistedMockWorker,
    getCloudSessions: () => HoistedMockOpenAiTranscriptionSession.instances,
    getCreatedWorkerCount: () => HoistedMockWorker.created,
    getLastWorker: () => HoistedMockWorker.instances.at(-1),
    readOpenAiSpeechApiKeyMock: vi.fn(() => 'test-openai-key'),
    resetCloudSessions: () => {
      HoistedMockOpenAiTranscriptionSession.instances = []
    },
    resetWorkers: () => {
      HoistedMockWorker.created = 0
      HoistedMockWorker.instances = []
      HoistedMockWorker.emitReadyOnInit = true
    }
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false
  }
}))

type WorkerMessage = { type: string; streamId?: string }

const spawnMockWorker = (): InstanceType<typeof MockWorker> => new MockWorker()

const stoppedReply = (worker: InstanceType<typeof MockWorker>) => ({
  type: 'stopped',
  streamId: worker.messages.findLast((message) => message.type === 'stop')?.streamId
})

const readyModels = (): ModelManager =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SttService reads only getModelState and getModelDir.
  ({
    getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
    getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
  }) as never

// Starting a session awaits the model check before it spawns the process.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

vi.mock('./model-catalog', () => ({
  getCatalogModel: (id: string) =>
    id === 'openai-model'
      ? {
          id,
          type: 'openai',
          provider: 'openai',
          streaming: false,
          sampleRate: 16000
        }
      : id === 'whisper-model'
        ? {
            id,
            type: 'whisper',
            provider: 'local',
            streaming: false,
            sampleRate: 16000,
            files: ['encoder.onnx', 'decoder.onnx', 'tokens.txt'],
            dictationLanguages: ['ja', 'ko']
          }
        : {
            id: 'model-a',
            type: 'transducer',
            provider: 'local',
            streaming: true,
            sampleRate: 16000,
            files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
          }
}))

vi.mock('./openai-api-key-store', () => ({
  readOpenAiSpeechApiKey: readOpenAiSpeechApiKeyMock
}))

vi.mock('./openai-transcription-client', () => ({
  OpenAiTranscriptionSession: MockOpenAiTranscriptionSession
}))

import {
  IDLE_WORKER_TEARDOWN_MS,
  START_DICTATION_TIMEOUT_MS,
  SttService,
  type SttEventSink
} from './stt-service'

describe('SttService', () => {
  beforeEach(() => {
    resetCloudSessions()
    resetWorkers()
    readOpenAiSpeechApiKeyMock.mockClear()
  })

  it('gives each device dictating at once only its own text from one recognizer', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    const desktop = vi.fn<SttEventSink>()
    const phone = vi.fn<SttEventSink>()

    await service.startDictation('model-a', desktop, undefined, 'desktop')
    await service.startDictation('model-a', phone, undefined, 'mobile:phone-a:1')
    service.feedAudio(new Float32Array([1]), 16000, 'desktop')
    service.feedAudio(new Float32Array([2]), 16000, 'mobile:phone-a:1')
    const worker = getLastWorker()!
    const [desktopStream, phoneStream] = worker.messages
      .filter((message) => message.type === 'feed')
      .map((message) => message.streamId)
    worker.emit('message', { type: 'final', streamId: phoneStream, text: 'from the phone' })
    worker.emit('message', { type: 'partial', streamId: desktopStream, text: 'from the desk' })
    await service.stopDictation('mobile:phone-a:1')
    service.feedAudio(new Float32Array([3]), 16000, 'desktop')

    expect(getCreatedWorkerCount()).toBe(1)
    expect(desktopStream).not.toBe(phoneStream)
    expect(phone.mock.calls).toEqual([
      [{ type: 'ready' }],
      [{ type: 'final', text: 'from the phone' }],
      [{ type: 'stopped' }]
    ])
    expect(desktop.mock.calls).toEqual([
      [{ type: 'ready' }],
      [{ type: 'partial', text: 'from the desk' }]
    ])
    expect(worker.messages.at(-1)).toMatchObject({ type: 'feed', streamId: desktopStream })
  })

  it('refuses a fifth device, and another model while devices are dictating', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    for (const owner of ['desktop', 'phone-1', 'phone-2', 'phone-3']) {
      await service.startDictation('model-a', vi.fn(), undefined, owner)
    }

    await expect(service.startDictation('model-a', vi.fn(), undefined, 'phone-4')).rejects.toThrow(
      'dictation_session_limit'
    )
    await service.stopDictation('phone-3')
    await expect(service.startDictation('model-b', vi.fn(), undefined, 'phone-4')).rejects.toThrow(
      'dictation_model_busy'
    )
    expect(getCreatedWorkerCount()).toBe(1)
  })

  it('does not kill another device dictation when a cancel waits behind a decode', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)
      const desktop = vi.fn<SttEventSink>()
      await service.startDictation('model-a', desktop, undefined, 'desktop')
      await service.startDictation('model-a', vi.fn(), undefined, 'mobile:phone-a:1')
      const worker = getLastWorker()!
      worker.answerDiscard = false

      const cancel = service.stopDictation('mobile:phone-a:1', { discard: true })
      await vi.advanceTimersByTimeAsync(5_000)
      await cancel
      await service.stopDictation('desktop')

      expect(worker.terminated).toBe(false)
      expect(desktop.mock.calls).toEqual([[{ type: 'ready' }], [{ type: 'stopped' }]])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reuses an idle warm worker for a second dictation with the same owner', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')

    expect(getCreatedWorkerCount()).toBe(1)
  })

  it('rebuilds the warm worker when the dictation language changes', async () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a local start reads only getModelState and getModelDir.
    const service = new SttService(
      {
        getModelState: vi.fn().mockResolvedValue({ id: 'whisper-model', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/whisper-model')
      } as never,
      spawnMockWorker
    )

    await service.startDictation('whisper-model', vi.fn(), undefined, 'desktop', 'ko')
    await service.stopDictation('desktop')
    await service.startDictation('whisper-model', vi.fn(), undefined, 'desktop', 'ja')

    expect(getCreatedWorkerCount()).toBe(2)
    expect(getLastWorker()!.messages.find((message) => message.type === 'init')).toMatchObject({
      language: 'ja'
    })
  })

  it('frees the warm worker at once when a local dictation is discarded', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'mobile:1')
    // Decoding the rest of the audio would hold the worker; a discard must not wait for it.
    getLastWorker()!.emitStoppedOnStop = false
    await service.stopDictation('mobile:1', { discard: true })
    await service.startDictation('model-a', vi.fn(), undefined, 'mobile:2')

    expect(getCreatedWorkerCount()).toBe(1)
  })

  it('kills a worker stuck in a decode instead of making a cancel wait for it', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)
      const events: { type: string }[] = []

      await service.startDictation('model-a', (event) => events.push(event), undefined, 'desktop')
      const worker = getLastWorker()!
      worker.answerDiscard = false
      const cancel = service.stopDictation('desktop', { discard: true })
      await vi.advanceTimersByTimeAsync(5_000)
      await cancel

      expect(worker.terminated).toBe(true)
      expect(events.map((event) => event.type)).toEqual(['ready', 'stopped'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a live dictation with an error when the worker process dies', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    const events: { type: string }[] = []

    await service.startDictation('model-a', (event) => events.push(event), undefined, 'desktop')
    getLastWorker()!.emit('exit', 1)

    expect(events.map((event) => event.type)).toEqual(['ready', 'error', 'stopped'])
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    expect(getCreatedWorkerCount()).toBe(2)
  })

  it('keeps an idle worker warm for an hour', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const worker = getLastWorker()
      expect(worker).toBeDefined()

      await service.stopDictation('desktop')
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1)
      expect(worker!.terminated).toBe(false)

      await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS - 5 * 60 * 1000 - 1)
      expect(worker!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resets the idle teardown timer after each stop', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const worker = getLastWorker()
      expect(worker).toBeDefined()

      await service.stopDictation('desktop')
      await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS / 2)
      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      await service.stopDictation('desktop')

      await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS / 2 + 1)
      expect(worker!.terminated).toBe(false)

      await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS / 2 - 1)
      expect(worker!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('drops stale audio while the worker is warm but no dictation owner is active', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop:1')
    const worker = getLastWorker()
    expect(worker).toBeDefined()

    await service.stopDictation('desktop:1')
    service.feedAudio(new Float32Array([1]), 16000, 'desktop:1')

    expect(worker!.messages.filter((message) => message.type === 'feed')).toHaveLength(0)
  })

  it('drops in-flight audio while stop is waiting for the worker', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop:1')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    worker!.emitStoppedOnStop = false

    const stopPromise = service.stopDictation('desktop:1')
    await Promise.resolve()
    service.feedAudio(new Float32Array([1]), 16000, 'desktop:1')
    expect(worker!.messages.filter((message) => message.type === 'feed')).toHaveLength(0)

    worker!.emit('message', stoppedReply(worker!))
    await stopPromise
  })

  it('rejects deletion prep while the target model is starting', async () => {
    let resolveModelState: (state: { id: string; status: string }) => void = () => {}
    const modelStatePromise = new Promise<{ id: string; status: string }>((resolve) => {
      resolveModelState = resolve
    })
    const service = new SttService(
      {
        getModelState: vi.fn(() => modelStatePromise),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never,
      spawnMockWorker
    )

    const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await Promise.resolve()

    await expect(service.prepareModelForDeletion('model-a')).rejects.toThrow('voice_model_in_use')

    resolveModelState({ id: 'model-a', status: 'ready' })
    await startPromise
    await service.stopDictation('desktop')
  })

  it('tears down an idle warm worker before deleting the target model', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    await service.stopDictation('desktop')

    await service.prepareModelForDeletion('model-a')

    expect(worker!.terminated).toBe(true)
  })

  it('uses the OpenAI transcription session without creating a worker', async () => {
    const sink = vi.fn()
    const service = new SttService(
      {
        getModelState: vi.fn().mockResolvedValue({ id: 'openai-model', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never,
      spawnMockWorker
    )

    await service.startDictation('openai-model', sink, undefined, 'desktop')
    service.feedAudio(new Float32Array([0.25, -0.25]), 48000, 'desktop')
    await service.stopDictation('desktop')

    expect(getCreatedWorkerCount()).toBe(0)
    expect(getCloudSessions()).toHaveLength(1)
    expect(getCloudSessions()[0].feedCalls).toHaveLength(1)
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
    expect(sink).toHaveBeenCalledWith({
      type: 'final',
      text: 'openai-model:test-openai-key'
    })
    expect(sink).toHaveBeenCalledWith({ type: 'stopped' })
  })

  it('frees an idle local recognizer when a cloud dictation starts', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')

    await service.startDictation('openai-model', vi.fn(), undefined, 'desktop')

    expect(getLastWorker()!.terminated).toBe(true)
  })

  it('reads the OpenAI key only when finishing cloud dictation', async () => {
    const service = new SttService(
      {
        getModelState: vi.fn().mockResolvedValue({ id: 'openai-model', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never,
      spawnMockWorker
    )

    await service.startDictation('openai-model', vi.fn(), undefined, 'desktop')
    service.feedAudio(new Float32Array([0.25]), 16000, 'desktop')

    expect(readOpenAiSpeechApiKeyMock).not.toHaveBeenCalled()

    await service.stopDictation('desktop')

    expect(readOpenAiSpeechApiKeyMock).toHaveBeenCalledOnce()
  })

  it('lets a model that is still loading finish when its dictation is canceled', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      MockWorker.emitReadyOnInit = false
      const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'mobile:1')
      const startOutcome = startPromise.catch((error: Error) => error.message)
      await vi.advanceTimersByTimeAsync(0)
      const worker = getLastWorker()!
      // The worker answers the cancel only after its model load.
      worker.answerDiscard = false
      const cancel = service.stopDictation('mobile:1', { discard: true })
      await vi.advanceTimersByTimeAsync(5_000)
      worker.answerDiscard = true
      worker.emit('message', { type: 'ready' })
      worker.emit('message', { type: 'stopped' })
      await cancel

      expect(await startOutcome).toBe('dictation_canceled')
      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      expect(getCreatedWorkerCount()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps startup cancellation tombstoned after the worker has been created', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    MockWorker.emitReadyOnInit = false
    const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop:1')
    await flushMicrotasks()
    const worker = getLastWorker()
    expect(worker).toBeDefined()

    await service.stopDictation('desktop:1')
    worker!.emit('message', { type: 'ready' })

    await expect(startPromise).rejects.toThrow('dictation_canceled')
    await expect(service.startDictation('model-a', vi.fn(), undefined, 'desktop:2')).resolves.toBe(
      undefined
    )
  })

  it('times out startup when the worker never reports ready', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      MockWorker.emitReadyOnInit = false
      const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop').then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error))
      )
      await flushMicrotasks()
      const worker = getLastWorker()
      expect(worker).toBeDefined()

      await vi.advanceTimersByTimeAsync(START_DICTATION_TIMEOUT_MS)
      const outcome = await Promise.race([startPromise, Promise.resolve('pending')])

      expect(outcome).toBe('Speech worker timed out while starting.')
      expect(worker!.terminated).toBe(true)
      expect(worker!.listenerCount('message')).toBe(0)
      expect(worker!.listenerCount('error')).toBe(0)
      expect(worker!.listenerCount('exit')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not treat internal warm-worker replacement as startup cancellation', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), '/tmp/hotwords-a.txt', 'desktop:1')
    await service.stopDictation('desktop:1')

    await expect(
      service.startDictation('model-a', vi.fn(), '/tmp/hotwords-b.txt', 'desktop:1')
    ).resolves.toBe(undefined)
  })

  it('removes lifecycle listeners when the active worker errors', async () => {
    const sink = vi.fn()
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', sink, undefined, 'desktop')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    expect(worker!.listenerCount('message')).toBe(1)
    expect(worker!.listenerCount('error')).toBe(1)
    expect(worker!.listenerCount('exit')).toBe(1)

    worker!.emit('error', new Error('worker failed'))

    expect(sink).toHaveBeenCalledWith({
      type: 'error',
      error: 'Error: worker failed'
    })
    expect(worker!.listenerCount('message')).toBe(0)
    expect(worker!.listenerCount('error')).toBe(0)
    expect(worker!.listenerCount('exit')).toBe(0)
  })

  it('allows slow offline stop decoding before terminating the worker', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const worker = getLastWorker()
      expect(worker).toBeDefined()
      worker!.emitStoppedOnStop = false

      const stopPromise = service.stopDictation('desktop')
      await vi.advanceTimersByTimeAsync(59_999)
      expect(worker!.terminated).toBe(false)

      await vi.advanceTimersByTimeAsync(1)
      await stopPromise
      expect(worker!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles stop when the worker exits during stop and does not reuse it', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    const events: { type: string }[] = []

    await service.startDictation('model-a', (event) => events.push(event), undefined, 'desktop')
    const firstWorker = getLastWorker()
    expect(firstWorker).toBeDefined()
    firstWorker!.emitStoppedOnStop = false

    const stopPromise = service.stopDictation('desktop')
    firstWorker!.emit('exit', 1)
    await stopPromise

    expect(events.map((event) => event.type)).toEqual(['ready', 'error', 'stopped'])

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')

    expect(getCreatedWorkerCount()).toBe(2)
    expect(getLastWorker()).not.toBe(firstWorker)
  })

  it('settles stop when the worker errors during stop and shares the outcome with follow-up stop', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    const events: unknown[] = []

    await service.startDictation(
      'model-a',
      (event) => {
        events.push(event)
        if (event.type === 'error') {
          void service.stopDictation('desktop')
        }
      },
      undefined,
      'desktop'
    )
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    worker!.emitStoppedOnStop = false
    // A real kill reports exit later, not inside the error event.
    worker!.emitExitOnTerminate = false

    const stopPromise = service.stopDictation('desktop')
    worker!.emit('error', new Error('native failure'))
    await stopPromise

    expect(worker!.messages.filter((message) => message.type === 'stop')).toHaveLength(1)
    expect(events).toContainEqual({ type: 'error', error: 'Error: native failure' })
    expect(events).toContainEqual({ type: 'stopped' })
  })

  it('shares one stop message across concurrent stop callers', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    worker!.emitStoppedOnStop = false

    const firstStop = service.stopDictation('desktop')
    const secondStop = service.stopDictation('desktop')
    expect(worker!.messages.filter((message) => message.type === 'stop')).toHaveLength(1)

    worker!.emit('message', stoppedReply(worker!))
    await Promise.all([firstStop, secondStop])
  })

  it('does not emit synthetic stopped when the worker reports stopped', async () => {
    const service = new SttService(readyModels(), spawnMockWorker)
    const events: unknown[] = []

    await service.startDictation('model-a', (event) => events.push(event), undefined, 'desktop')
    await service.stopDictation('desktop')

    expect(events.filter((event) => (event as { type?: string }).type === 'stopped')).toHaveLength(
      1
    )
  })

  it('does not retain or reuse a worker that timed out while stopping', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const firstWorker = getLastWorker()
      expect(firstWorker).toBeDefined()
      firstWorker!.emitStoppedOnStop = false

      const stopPromise = service.stopDictation('desktop')
      await vi.advanceTimersByTimeAsync(60_000)
      await stopPromise

      expect(firstWorker!.terminated).toBe(true)
      expect(firstWorker!.listenerCount('message')).toBe(0)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')

      expect(getCreatedWorkerCount()).toBe(2)
      expect(getLastWorker()).not.toBe(firstWorker)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not wait for worker termination to resolve a timed-out stop', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)

      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const worker = getLastWorker()
      expect(worker).toBeDefined()
      worker!.emitStoppedOnStop = false
      worker!.emitExitOnTerminate = false
      worker!.terminatePromise = new Promise(() => {})

      const stopPromise = service.stopDictation('desktop').then(() => 'resolved')
      await vi.advanceTimersByTimeAsync(60_000)
      const outcome = await Promise.race([stopPromise, Promise.resolve('pending')])

      expect(outcome).toBe('resolved')
      expect(worker!.terminated).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects idle warm reuse when the model is no longer ready', async () => {
    let modelStatus = 'ready'
    const getModelState = vi.fn().mockImplementation(async () => ({
      id: 'model-a',
      status: modelStatus
    }))
    const service = new SttService(
      {
        getModelState,
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never,
      spawnMockWorker
    )

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    const firstWorker = getLastWorker()
    expect(firstWorker).toBeDefined()
    await service.stopDictation('desktop')

    modelStatus = 'missing'
    await expect(service.startDictation('model-a', vi.fn(), undefined, 'desktop')).rejects.toThrow(
      'Model not ready: missing'
    )
    expect(firstWorker!.terminated).toBe(true)

    modelStatus = 'ready'
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')

    expect(getCreatedWorkerCount()).toBe(2)
    expect(getLastWorker()).not.toBe(firstWorker)
  })

  it.each(['exit', 'error'] as const)(
    'releases the idle teardown timer after a warm worker %s',
    async (event) => {
      vi.useFakeTimers()
      try {
        const models: Pick<ModelManager, 'getModelState' | 'getModelDir'> = {
          getModelState: vi.fn<ModelManager['getModelState']>().mockResolvedValue({
            id: 'model-a',
            status: 'ready'
          }),
          getModelDir: vi.fn<ModelManager['getModelDir']>().mockReturnValue('/tmp/model-a')
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This lifecycle reads only getModelState/getModelDir on the model manager.
        const service = new SttService(models as ModelManager, spawnMockWorker)
        const sink = vi.fn<SttEventSink>()
        await service.startDictation('model-a', sink, undefined, 'desktop')
        const retired = getLastWorker()
        if (!retired) {
          throw new Error('Missing warm speech worker')
        }
        await service.stopDictation('desktop')
        expect(sink.mock.calls).toEqual([[{ type: 'ready' }], [{ type: 'stopped' }]])
        expect(retired.terminated).toBe(false)
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
        retired.emit(event, event === 'exit' ? 0 : new Error('idle worker failed'))
        expect(sink.mock.calls).toEqual([[{ type: 'ready' }], [{ type: 'stopped' }]])
        for (const name of ['message', 'error', 'exit']) {
          expect(retired.listenerCount(name)).toBe(0)
        }
        service.feedAudio(new Float32Array([1]), 16000, 'desktop')
        expect(retired.messages.filter((message) => message.type === 'feed')).toHaveLength(0)
        const retiredTimerCount = vi.getTimerCount()
        await service.startDictation('model-a', sink, undefined, 'desktop')
        const successor = getLastWorker()
        if (!successor) {
          throw new Error('Missing successor speech worker')
        }
        expect(successor).not.toBe(retired)
        await service.stopDictation('desktop')
        expect(vi.getTimerCount()).toBe(1)
        retired.emit('exit', 0)
        retired.emit('error', new Error('retired error'))
        expect(sink.mock.calls).toEqual([
          [{ type: 'ready' }],
          [{ type: 'stopped' }],
          [{ type: 'ready' }],
          [{ type: 'stopped' }]
        ])
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(IDLE_WORKER_TEARDOWN_MS - 1)
        expect(successor.terminated).toBe(false)
        await vi.advanceTimersByTimeAsync(1)
        expect(successor.terminated).toBe(true)
        expect(retiredTimerCount).toBe(0)
      } finally {
        vi.clearAllTimers()
        vi.useRealTimers()
      }
    }
  )
})
