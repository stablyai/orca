import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockWorker, getCreatedWorkerCount, getLastWorker, resetWorkers } = vi.hoisted(() => {
  class HoistedMockWorker extends EventTarget {
    static created = 0
    static instances: HoistedMockWorker[] = []
    terminated = false
    emitStoppedOnStop = true
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
      if (message.type === 'init') {
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

import { SttService } from './stt-service'

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
