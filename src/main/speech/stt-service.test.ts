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
    emitReadyOnInit = HoistedMockWorker.emitReadyOnInit
    messages: WorkerMessage[] = []
    private listeners = new Map<string, Set<(...args: unknown[]) => void>>()

    constructor(_path: string, _options: unknown) {
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
      if (message.type === 'stop' && this.emitStoppedOnStop) {
        queueMicrotask(() => this.emit('message', { type: 'stopped' }))
      }
      if (message.type === 'teardown') {
        this.terminated = true
      }
    }

    terminate(): Promise<void> {
      this.terminated = true
      this.emit('exit', 0)
      return Promise.resolve()
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

type WorkerMessage = { type: string }

vi.mock('worker_threads', () => ({
  Worker: MockWorker
}))

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

import { IDLE_WORKER_TEARDOWN_MS, START_DICTATION_TIMEOUT_MS, SttService } from './stt-service'

describe('SttService', () => {
  beforeEach(() => {
    resetCloudSessions()
    resetWorkers()
    readOpenAiSpeechApiKeyMock.mockClear()
  })

  it('reuses an idle warm worker for a second dictation with the same owner', async () => {
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')

    expect(getCreatedWorkerCount()).toBe(1)
  })

  it('keeps an idle worker warm for an hour', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService({
        getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never)

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
      const service = new SttService({
        getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never)

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
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop:1')
    const worker = getLastWorker()
    expect(worker).toBeDefined()

    await service.stopDictation('desktop:1')
    service.feedAudio(new Float32Array([1]), 16000, 'desktop:1')

    expect(worker!.messages.filter((message) => message.type === 'feed')).toHaveLength(0)
  })

  it('rejects deletion prep while the target model is starting', async () => {
    let resolveModelState: (state: { id: string; status: string }) => void = () => {}
    const modelStatePromise = new Promise<{ id: string; status: string }>((resolve) => {
      resolveModelState = resolve
    })
    const service = new SttService({
      getModelState: vi.fn(() => modelStatePromise),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await Promise.resolve()

    await expect(service.prepareModelForDeletion('model-a')).rejects.toThrow('voice_model_in_use')

    resolveModelState({ id: 'model-a', status: 'ready' })
    await startPromise
    await service.stopDictation('desktop')
  })

  it('tears down an idle warm worker before deleting the target model', async () => {
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    await service.stopDictation('desktop')

    await service.prepareModelForDeletion('model-a')

    expect(worker!.messages.some((message) => message.type === 'teardown')).toBe(true)
    expect(worker!.terminated).toBe(true)
    expect(service.isActive()).toBe(false)
  })

  it('rejects deletion prep when a target warm worker cannot be torn down during another start', async () => {
    let resolveModelState: (state: { id: string; status: string }) => void = () => {}
    const secondModelState = new Promise<{ id: string; status: string }>((resolve) => {
      resolveModelState = resolve
    })
    const getModelState = vi
      .fn()
      .mockResolvedValueOnce({ id: 'model-a', status: 'ready' })
      .mockReturnValue(secondModelState)
    const service = new SttService({
      getModelState,
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')
    const startOtherModel = service.startDictation('model-b', vi.fn(), undefined, 'desktop')
    await Promise.resolve()

    await expect(service.prepareModelForDeletion('model-a')).rejects.toThrow('voice_model_in_use')

    resolveModelState({ id: 'model-b', status: 'ready' })
    await startOtherModel
    await service.stopDictation('desktop')
  })

  it('uses the OpenAI transcription session without creating a worker', async () => {
    const sink = vi.fn()
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'openai-model', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

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

  it('reads the OpenAI key only when finishing cloud dictation', async () => {
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'openai-model', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('openai-model', vi.fn(), undefined, 'desktop')
    service.feedAudio(new Float32Array([0.25]), 16000, 'desktop')

    expect(readOpenAiSpeechApiKeyMock).not.toHaveBeenCalled()

    await service.stopDictation('desktop')

    expect(readOpenAiSpeechApiKeyMock).toHaveBeenCalledOnce()
  })

  it('keeps startup cancellation tombstoned after the worker has been created', async () => {
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    MockWorker.emitReadyOnInit = false
    const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop:1')
    await Promise.resolve()
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
      const service = new SttService({
        getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never)

      MockWorker.emitReadyOnInit = false
      const startPromise = service.startDictation('model-a', vi.fn(), undefined, 'desktop').then(
        () => 'resolved',
        (error) => (error instanceof Error ? error.message : String(error))
      )
      await Promise.resolve()
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
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', vi.fn(), '/tmp/hotwords-a.txt', 'desktop:1')
    await service.stopDictation('desktop:1')

    await expect(
      service.startDictation('model-a', vi.fn(), '/tmp/hotwords-b.txt', 'desktop:1')
    ).resolves.toBe(undefined)
  })

  it('removes lifecycle listeners when the active worker errors', async () => {
    const sink = vi.fn()
    const service = new SttService({
      getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
      getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
    } as never)

    await service.startDictation('model-a', sink, undefined, 'desktop')
    const worker = getLastWorker()
    expect(worker).toBeDefined()
    expect(worker!.listenerCount('message')).toBe(1)
    expect(worker!.listenerCount('error')).toBe(1)
    expect(worker!.listenerCount('exit')).toBe(1)

    worker!.emit('error', new Error('worker failed'))

    expect(service.isActive()).toBe(false)
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
      const service = new SttService({
        getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never)

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

  it('does not retain or reuse a worker that timed out while stopping', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService({
        getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
        getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
      } as never)

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
})
