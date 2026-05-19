import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockWorker, getCreatedWorkerCount, getLastWorker, resetWorkers } = vi.hoisted(() => {
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

  return {
    MockWorker: HoistedMockWorker,
    getCreatedWorkerCount: () => HoistedMockWorker.created,
    getLastWorker: () => HoistedMockWorker.instances.at(-1),
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
  getCatalogModel: () => ({
    id: 'model-a',
    type: 'transducer',
    streaming: true,
    sampleRate: 16000,
    files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
  })
}))

import { IDLE_WORKER_TEARDOWN_MS, SttService } from './stt-service'

describe('SttService', () => {
  beforeEach(() => {
    resetWorkers()
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
})
