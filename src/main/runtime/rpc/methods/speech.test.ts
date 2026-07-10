import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { SPEECH_METHODS } from './speech'

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

describe('speech RPC methods', () => {
  it('feeds valid base64 dictation chunks to the runtime', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      feedMobileDictation: vi.fn().mockReturnValue({ dictationId: 'dict-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.chunk', {
        dictationId: 'dict-1',
        audioBase64: 'AAAA',
        sampleRate: 16_000
      })
    )

    expect(response).toMatchObject({ ok: true, result: { dictationId: 'dict-1' } })
    expect(runtime.feedMobileDictation).toHaveBeenCalledWith({
      dictationId: 'dict-1',
      audioBase64: 'AAAA',
      sampleRate: 16_000,
      clientId: undefined,
      connectionId: undefined
    })
  })

  it('rejects malformed base64 dictation chunks before feeding audio', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      feedMobileDictation: vi.fn().mockReturnValue({ dictationId: 'dict-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.chunk', {
        dictationId: 'dict-1',
        audioBase64: '!!!!',
        sampleRate: 16_000
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.feedMobileDictation).not.toHaveBeenCalled()
  })

  it('rejects oversized dictation chunks before decoding audio', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      feedMobileDictation: vi.fn().mockReturnValue({ dictationId: 'dict-1' })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.chunk', {
        dictationId: 'dict-1',
        audioBase64: 'A'.repeat(Math.ceil((16_000 * 2 * 5) / 3) * 4 + 1),
        sampleRate: 16_000
      })
    )

    expect(response).toMatchObject({ ok: false })
    expect(runtime.feedMobileDictation).not.toHaveBeenCalled()
  })

  it('lists speech models', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      listMobileSpeechModels: vi
        .fn()
        .mockResolvedValue({ enabled: false, selectedModelId: '', models: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('speech.models.list', null))

    expect(runtime.listMobileSpeechModels).toHaveBeenCalled()
    expect(response).toMatchObject({ ok: true, result: { enabled: false, models: [] } })
  })

  it('starts a model download', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      downloadMobileSpeechModel: vi.fn().mockResolvedValue({ started: true })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.models.download', { modelId: 'parakeet-tdt-0.6b-v3-int8' })
    )

    expect(runtime.downloadMobileSpeechModel).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3-int8')
    expect(response).toMatchObject({ ok: true, result: { started: true } })
  })

  it('deletes a speech model and returns refreshed setup', async () => {
    const setup = { enabled: true, selectedModelId: '', dictationMode: 'toggle', models: [] }
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      deleteMobileSpeechModel: vi.fn().mockResolvedValue(setup)
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.models.delete', { modelId: 'parakeet-tdt-0.6b-v3-int8' })
    )

    expect(runtime.deleteMobileSpeechModel).toHaveBeenCalledWith('parakeet-tdt-0.6b-v3-int8')
    expect(response).toMatchObject({ ok: true, result: setup })
  })

  it('rejects invalid speech model delete params', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      deleteMobileSpeechModel: vi.fn()
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(makeRequest('speech.models.delete', {}))

    expect(response).toMatchObject({ ok: false })
    expect(runtime.deleteMobileSpeechModel).not.toHaveBeenCalled()
  })

  it('configures dictation enable + model selection', async () => {
    const runtime = {
      getRuntimeId: () => 'test-runtime',
      configureMobileDictation: vi
        .fn()
        .mockResolvedValue({ enabled: true, selectedModelId: 'm1', models: [] })
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: SPEECH_METHODS })

    const response = await dispatcher.dispatch(
      makeRequest('speech.dictation.setup', { enabled: true, modelId: 'm1' })
    )

    expect(runtime.configureMobileDictation).toHaveBeenCalledWith({ enabled: true, modelId: 'm1' })
    expect(response).toMatchObject({ ok: true, result: { enabled: true, selectedModelId: 'm1' } })
  })
})
