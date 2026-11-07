import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpeechModelStatus } from '../../shared/speech-types'
import { SttService } from './stt-service'
import { SttWorkerChildProcess } from './stt-worker-process'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

vi.mock('./model-catalog', () => ({
  isLocalSpeechModel: () => true,
  getCatalogModel: (id: string) => ({
    id,
    type: 'transducer',
    provider: 'local',
    streaming: true,
    sampleRate: 16000,
    files: ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
  })
}))

type FakeChild = { worker: SttWorkerChildProcess; modelDir: string; killed: boolean }

function createService(
  options: {
    status?: Record<string, SpeechModelStatus>
    answerInit?: boolean | 'error'
    modelStateGate?: Promise<void>
  } = {}
): { service: SttService; children: FakeChild[] } {
  const children: FakeChild[] = []
  const spawn = (): SttWorkerChildProcess => {
    const child: FakeChild = {
      modelDir: '',
      killed: false,
      worker: new SttWorkerChildProcess({
        send: (message) => {
          if (message.type === 'init') {
            child.modelDir = message.modelDir
            if (options.answerInit === 'error') {
              queueMicrotask(() => child.worker.receiveMessage({ type: 'error', error: 'bad' }))
            } else if (options.answerInit !== false) {
              queueMicrotask(() => child.worker.receiveMessage({ type: 'ready' }))
            }
          } else if (message.type === 'stop' || message.type === 'discard') {
            const { streamId } = message
            queueMicrotask(() => child.worker.receiveMessage({ type: 'stopped', streamId }))
          }
        },
        kill: () => {
          child.killed = true
          child.worker.receiveExit(0)
        }
      })
    }
    children.push(child)
    return child.worker
  }
  const models = {
    getModelState: async (id: string) => {
      await options.modelStateGate
      return { id, status: options.status?.[id] ?? 'ready' }
    },
    getModelDir: (id: string) => `/models/${id}`
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: local starts read only getModelState and getModelDir.
  return { service: new SttService(models as never, spawn), children }
}

describe('SttService model pre-warm', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('loads the model before the first dictation, which then reuses it', async () => {
    const { service, children } = createService()
    const sink = vi.fn()

    await service.prewarm('model-a')
    expect(children).toHaveLength(1)
    await service.startDictation('model-a', sink, undefined, 'desktop')

    expect(children).toHaveLength(1)
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('holds a dictation started mid pre-warm until the model has loaded', async () => {
    const { service, children } = createService({ answerInit: false })
    const sink = vi.fn()

    const warming = service.prewarm('model-a')
    await vi.waitFor(() => expect(children[0]?.modelDir).toBe('/models/model-a'))
    const start = service.startDictation('model-a', sink, undefined, 'desktop')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sink).not.toHaveBeenCalled()

    children[0].worker.receiveMessage({ type: 'ready' })
    await Promise.all([warming, start])

    expect(children).toHaveLength(1)
    expect(sink).toHaveBeenCalledWith({ type: 'ready' })
  })

  it('does not load a model that is not downloaded', async () => {
    const { service, children } = createService({ status: { 'model-a': 'not-downloaded' } })

    await service.prewarm('model-a')

    expect(children).toHaveLength(0)
  })

  it('frees the idle model when a model that is not downloaded is selected', async () => {
    const { service, children } = createService({ status: { 'model-b': 'not-downloaded' } })
    await service.prewarm('model-a')

    await service.prewarm('model-b')

    expect(children).toHaveLength(1)
    expect(children[0].killed).toBe(true)
  })

  it('retries a model that failed to load only when asked to', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { service, children } = createService({ answerInit: 'error' })

    await service.prewarm('model-a')
    await service.prewarm('model-a')
    expect(children).toHaveLength(1)

    await service.prewarm('model-a', undefined, true)
    expect(children).toHaveLength(2)
  })

  it('does not count a load cut short by an unload as a failure', async () => {
    const { service, children } = createService({ answerInit: false })
    const warming = service.prewarm('model-a')
    await vi.waitFor(() => expect(children[0]?.modelDir).toBe('/models/model-a'))

    await service.unloadIdleModel()
    await warming
    void service.prewarm('model-a')

    await vi.waitFor(() => expect(children).toHaveLength(2))
  })

  it('does not load the model when voice is turned off while it checks the model', async () => {
    const gate = Promise.withResolvers<void>()
    const { service, children } = createService({ modelStateGate: gate.promise })
    const warming = service.prewarm('model-a')

    await service.unloadIdleModel()
    gate.resolve()
    await warming

    expect(children).toHaveLength(0)
  })

  it('unloads a pre-warmed model after the default 15 idle minutes', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()

    await service.prewarm('model-a')
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000 - 1)
    expect(children[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    expect(children[0].killed).toBe(true)
  })

  it('keeps an idle model loaded when set to never unload', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()
    service.setIdleUnloadDelay(null)

    await service.prewarm('model-a')
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000)

    expect(children[0].killed).toBe(false)
  })

  it('skips pre-warm and unloads after each dictation when set to immediately', async () => {
    vi.useFakeTimers()
    const { service, children } = createService()
    service.setIdleUnloadDelay(0)

    await service.prewarm('model-a')
    expect(children).toHaveLength(0)
    await service.startDictation('model-a', vi.fn(), undefined, 'desktop')
    await service.stopDictation('desktop')
    await vi.advanceTimersByTimeAsync(0)

    expect(children[0].killed).toBe(true)
  })

  it('unloads the idle model at once when the setting changes to immediately', async () => {
    const { service, children } = createService()
    await service.prewarm('model-a')

    service.setIdleUnloadDelay(0)

    await vi.waitFor(() => expect(children[0].killed).toBe(true))
  })
})
