import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelManager } from './model-manager'
import type { SttEventSink } from './stt-service'

const { FakeCloudSession, createSessionMock } = vi.hoisted(() => {
  class HoistedFakeCloudSession {
    static instances: HoistedFakeCloudSession[] = []
    canceled = false
    feedError: Error | null = null
    private releaseFinish: ((text: string) => void) | null = null
    private rejectFinish: ((error: Error) => void) | null = null

    constructor(readonly sink: SttEventSink) {
      HoistedFakeCloudSession.instances.push(this)
    }

    feedAudio(): void {
      if (this.feedError) {
        throw this.feedError
      }
    }

    finish(): Promise<string> {
      return new Promise((resolve, reject) => {
        this.releaseFinish = resolve
        this.rejectFinish = reject
      })
    }

    cancel(): void {
      this.canceled = true
      this.rejectFinish?.(new Error('This operation was aborted'))
    }

    resolveFinish(text: string): void {
      this.releaseFinish?.(text)
    }
  }
  return {
    FakeCloudSession: HoistedFakeCloudSession,
    createSessionMock: vi.fn(
      (_manifest: unknown, options: { sink: SttEventSink }) =>
        new HoistedFakeCloudSession(options.sink)
    )
  }
})

vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('./model-catalog', () => ({
  getCatalogModel: (id: string) => ({
    id,
    type: 'cloud',
    provider: 'groq',
    streaming: false,
    sampleRate: 16000,
    transcriptionLanguages: 'any'
  })
}))
vi.mock('./cloud-speech-key-store', () => ({ readCloudSpeechApiKey: () => 'key' }))
vi.mock('./cloud-speech-session-factory', () => ({ createCloudSpeechSession: createSessionMock }))

import { SttService } from './stt-service'

function createService(): SttService {
  const models = { getModelState: vi.fn().mockResolvedValue({ status: 'ready' }) }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cloud start path reads only getModelState on the model manager.
  return new SttService(models as unknown as ModelManager)
}

const AUDIO = new Float32Array([0.1, 0.2])

beforeEach(() => {
  FakeCloudSession.instances = []
  createSessionMock.mockClear()
})

describe('SttService cloud stop lifecycle', () => {
  it('refuses a same-owner restart while the previous finish is uploading', async () => {
    const service = createService()
    const firstSink = vi.fn()
    await service.startDictation('cloud', firstSink, undefined, 'desktop')
    const stopping = service.stopDictation('desktop')

    await expect(service.startDictation('cloud', vi.fn(), undefined, 'desktop')).rejects.toThrow(
      'dictation_already_active'
    )

    FakeCloudSession.instances[0].resolveFinish('first words')
    await stopping
    expect(firstSink).toHaveBeenCalledWith({ type: 'final', text: 'first words' })
    expect(firstSink).toHaveBeenLastCalledWith({ type: 'stopped' })

    const secondSink = vi.fn()
    await service.startDictation('cloud', secondSink, undefined, 'desktop')
    expect(secondSink).toHaveBeenCalledWith({ type: 'ready' })
    expect(service.isActive()).toBe(true)
  })

  it('lets a discard stop abort an upload that is already finishing', async () => {
    const service = createService()
    const sink = vi.fn()
    await service.startDictation('cloud', sink, undefined, 'mobile:a')
    service.feedAudio(AUDIO, 16000, 'mobile:a')
    const finishing = service.stopDictation('mobile:a')

    await service.stopDictation('mobile:a', { discard: true })
    await finishing

    expect(FakeCloudSession.instances[0].canceled).toBe(true)
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    expect(sink).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'final' }))
    expect(sink.mock.calls.filter(([event]) => event.type === 'stopped')).toHaveLength(1)
  })

  it('rejects a stop from another owner while a finish is in flight', async () => {
    const service = createService()
    await service.startDictation('cloud', vi.fn(), undefined, 'mobile:a')
    const finishing = service.stopDictation('mobile:a')

    await expect(service.stopDictation('desktop', { discard: true })).rejects.toThrow(
      'dictation_owner_mismatch'
    )

    FakeCloudSession.instances[0].resolveFinish('')
    await finishing
  })

  it('rejects start cleanly when the provider session cannot be created', async () => {
    const service = createService()
    const sink = vi.fn()
    createSessionMock.mockImplementationOnce(() => {
      throw new Error('Soniox API key is not configured')
    })

    await expect(service.startDictation('cloud', sink, undefined, 'desktop')).rejects.toThrow(
      'Soniox API key is not configured'
    )

    expect(sink).not.toHaveBeenCalled()
    expect(service.isActive()).toBe(false)
    await service.startDictation('cloud', vi.fn(), undefined, 'mobile:b')
    expect(service.isActive()).toBe(true)
  })

  it('reports a cloud feed failure to the sink once and rethrows it', async () => {
    const service = createService()
    const sink = vi.fn()
    await service.startDictation('cloud', sink, undefined, 'desktop')
    FakeCloudSession.instances[0].feedError = new Error('limited to 10 minutes')

    expect(() => service.feedAudio(AUDIO, 16000, 'desktop')).toThrow('limited to 10 minutes')
    expect(() => service.feedAudio(AUDIO, 16000, 'desktop')).toThrow('limited to 10 minutes')

    expect(sink.mock.calls.filter(([event]) => event.type === 'error')).toEqual([
      [{ type: 'error', error: 'limited to 10 minutes' }]
    ])
  })
})
