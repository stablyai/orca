import type { ModelManager } from './model-manager'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { MockWorker, getCreatedWorkerCount, getLastWorker, resetWorkers } = vi.hoisted(() => {
  class HoistedMockWorker extends EventTarget {
    static created = 0
    static instances: HoistedMockWorker[] = []
    static emitReadyOnInit = true
    terminated = false
    emitStoppedOnStop = true
    answerDiscard = true
    /** False: a decode for the canceled stream never ends, so the queue never reaches its discard. */
    reachDiscard = true
    emitReadyOnInit = HoistedMockWorker.emitReadyOnInit
    emitExitOnTerminate = true
    terminatePromise: Promise<number> | null = null
    messages: WorkerMessage[] = []
    attachedPorts: { streamId: string; port: unknown }[] = []
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
      if (message.type === 'discard' && this.answerDiscard && this.reachDiscard) {
        queueMicrotask(() =>
          this.emit('message', { type: 'discarded', streamId: message.streamId })
        )
      }
    }

    attachAudioPort(streamId: string, port: unknown): boolean {
      this.attachedPorts.push({ streamId, port })
      return true
    }

    terminate(): Promise<number> {
      this.terminated = true
      if (this.emitExitOnTerminate) {
        this.emit('exit', 0)
      }
      return this.terminatePromise ?? Promise.resolve(0)
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

type WorkerMessage = { type: string; streamId?: string }

const spawnMockWorker = (): InstanceType<typeof MockWorker> => new MockWorker()

const stoppedReply = (worker: InstanceType<typeof MockWorker>) => ({
  type: 'stopped',
  streamId: worker.messages.findLast((message) => message.type === 'stop')?.streamId
})

const testModels = (
  models: Pick<ModelManager, 'getModelState' | 'getModelDir'>,
  onModelStateChange: ModelManager['setProgressCallback'] = () => () => {}
): ModelManager =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SttService reads getModelState and getModelDir, fetches the VAD with downloadModel and watches it land.
  ({
    ...models,
    downloadModel: vi.fn().mockResolvedValue(undefined),
    setProgressCallback: onModelStateChange
  }) as never

const readyModels = (): ModelManager =>
  testModels({
    getModelState: vi.fn().mockResolvedValue({ id: 'model-a', status: 'ready' }),
    getModelDir: vi.fn().mockReturnValue('/tmp/model-a')
  })

// Starting a session awaits the model check before it spawns the process.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve()
  }
}

vi.mock('./model-catalog', () => ({
  isLocalSpeechModel: (manifest: { provider: string }) => manifest.provider === 'local',
  getCatalogModel: (id: string) =>
    id === 'openai-model'
      ? {
          id,
          type: 'openai',
          provider: 'openai',
          language: 'multilingual',
          streaming: false,
          sampleRate: 16000
        }
      : id === 'whisper-model'
        ? {
            id,
            type: 'whisper',
            provider: 'local',
            language: 'multilingual',
            streaming: false,
            sampleRate: 16000,
            files: ['encoder.onnx', 'decoder.onnx', 'tokens.txt'],
            dictationLanguages: ['ja', 'ko']
          }
        : {
            id: 'model-a',
            type: 'transducer',
            provider: 'local',
            language: 'en',
            streaming: true,
            sampleRate: 16000,
            files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
          }
}))

vi.mock('./cloud-transcription-target', () => ({
  resolveCloudTranscriptionTarget: (modelId: string) => ({
    model: modelId,
    apiKey: 'test-openai-key'
  })
}))

vi.mock('./openai-transcription-client', () => ({
  OpenAiTranscriptionSession: class {}
}))

import { SttService, type SttEventSink } from './stt-service'

describe('SttService', () => {
  beforeEach(() => {
    resetWorkers()
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

  it('restarts the speech process when a canceled decode is still running as the next dictation starts', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)
      await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      const hung = getLastWorker()!
      hung.reachDiscard = false
      await service.stopDictation('desktop', { discard: true })

      const next = service.startDictation('model-a', vi.fn(), undefined, 'desktop')
      await vi.advanceTimersByTimeAsync(2_000)
      await next

      expect(hung.terminated).toBe(true)
      expect(getLastWorker()).not.toBe(hung)
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

  it('lets a finish run past the stop timeout while the engine keeps sending its text', async () => {
    vi.useFakeTimers()
    try {
      const service = new SttService(readyModels(), spawnMockWorker)
      const sink = vi.fn()
      await service.startDictation('model-a', sink, undefined, 'desktop')
      const worker = getLastWorker()!
      worker.emitStoppedOnStop = false

      const stopPromise = service.stopDictation('desktop')
      const { streamId } = stoppedReply(worker)
      await vi.advanceTimersByTimeAsync(50_000)
      worker.emit('message', { type: 'final', streamId, text: 'first phrase' })
      await vi.advanceTimersByTimeAsync(50_000)
      worker.emit('message', { type: 'final', streamId, text: 'second phrase' })
      await vi.advanceTimersByTimeAsync(50_000)
      worker.emit('message', stoppedReply(worker))
      await stopPromise

      expect(worker.terminated).toBe(false)
      expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
      expect(sink).toHaveBeenCalledWith({ type: 'final', text: 'second phrase' })
    } finally {
      vi.useRealTimers()
    }
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
})
