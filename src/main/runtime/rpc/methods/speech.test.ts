import { SPEECH_OPENROUTER_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeSpeechSetupState } from '../../../../shared/runtime-worktree-contracts'
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

const setup: RuntimeSpeechSetupState = {
  enabled: true,
  selectedModelId: 'openrouter-mai-transcribe-2',
  dictationMode: 'toggle',
  models: [
    {
      id: 'local',
      label: 'Local',
      provider: 'local',
      sizeBytes: 100,
      recommended: true,
      status: 'ready',
      progress: null
    },
    {
      id: 'openai',
      label: 'OpenAI',
      provider: 'openai',
      sizeBytes: null,
      recommended: false,
      status: 'ready',
      progress: null
    },
    {
      id: 'openrouter-mai-transcribe-2',
      label: 'MAI',
      provider: 'openrouter',
      sizeBytes: null,
      recommended: false,
      status: 'ready',
      progress: null
    }
  ]
}

function makeCatalogDispatcher() {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    listMobileSpeechModels: vi.fn().mockResolvedValue(setup),
    deleteMobileSpeechModel: vi.fn().mockResolvedValue(setup),
    configureMobileDictation: vi.fn().mockResolvedValue(setup),
    startMobileDictation: vi.fn().mockResolvedValue({ dictationId: 'dict-1' })
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These methods exercise only the runtime members stubbed above.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: SPEECH_METHODS
  })
  return { dispatcher, runtime }
}

describe('speech catalog capability', () => {
  it.each([
    ['speech.models.list', null],
    ['speech.models.delete', { modelId: 'local' }],
    ['speech.dictation.setup', { enabled: true }]
  ])('projects every %s reply for old and current clients', async (method, params) => {
    const { dispatcher } = makeCatalogDispatcher()
    const request = makeRequest(method, params)
    for (const clientKind of ['mobile', 'runtime'] as const) {
      for (const clientCapabilities of [undefined, [], [SPEECH_OPENROUTER_RUNTIME_CAPABILITY]]) {
        const response = await dispatcher.dispatch(request, { clientKind, clientCapabilities })
        expect(response).toMatchObject({
          ok: true,
          result: {
            ...setup,
            models: clientCapabilities?.length ? setup.models : setup.models.slice(0, 2)
          }
        })
      }
    }
    expect(await dispatcher.dispatch(request)).toMatchObject({ ok: true, result: setup })
    expect(setup.models).toHaveLength(3)
  })
})

describe('speech model capability before recording', () => {
  it.each([undefined, '', 'openrouter-mai-transcribe-2'])(
    'refuses a legacy start with modelId %s before recording',
    async (modelId) => {
      const { dispatcher, runtime } = makeCatalogDispatcher()
      for (const clientKind of ['mobile', 'runtime'] as const) {
        const response = await dispatcher.dispatch(
          makeRequest('speech.dictation.start', { dictationId: 'dict-1', modelId }),
          { clientKind, clientCapabilities: [] }
        )
        expect(response).toMatchObject({
          ok: false,
          error: { message: expect.stringMatching(/^voice_model_not_ready:.*Update/) }
        })
      }
      expect(runtime.startMobileDictation).not.toHaveBeenCalled()
    }
  )

  it.each([undefined, 'mobile', 'runtime'] as const)(
    'preserves OpenRouter for capable or internal %s callers',
    async (clientKind) => {
      const { dispatcher, runtime } = makeCatalogDispatcher()
      const options = { clientKind, clientCapabilities: [SPEECH_OPENROUTER_RUNTIME_CAPABILITY] }
      expect(
        await dispatcher.dispatch(
          makeRequest('speech.dictation.start', { dictationId: 'dict-1' }),
          clientKind ? options : undefined
        )
      ).toMatchObject({ ok: true })
      expect(runtime.listMobileSpeechModels).not.toHaveBeenCalled()
      expect(runtime.startMobileDictation).toHaveBeenCalledWith({
        dictationId: 'dict-1',
        clientId: undefined,
        connectionId: undefined
      })
    }
  )

  it.each(['local', 'openai'])(
    'pins a legacy %s selection before the host can change it',
    async (modelId) => {
      const { dispatcher, runtime } = makeCatalogDispatcher()
      const snapshot = { ...setup, selectedModelId: modelId }
      runtime.listMobileSpeechModels.mockImplementation(async () => {
        runtime.listMobileSpeechModels.mockResolvedValue(setup)
        return snapshot
      })
      const request = makeRequest('speech.dictation.start', { dictationId: 'dict-1' })
      expect(await dispatcher.dispatch(request, { clientKind: 'mobile' })).toMatchObject({
        ok: true
      })
      expect(runtime.startMobileDictation).toHaveBeenCalledWith(
        expect.objectContaining({ modelId })
      )
      runtime.startMobileDictation.mockClear()
      expect(await dispatcher.dispatch(request, { clientKind: 'mobile' })).toMatchObject({
        ok: false
      })
      expect(runtime.startMobileDictation).not.toHaveBeenCalled()
      expect(
        await dispatcher.dispatch(
          makeRequest('speech.dictation.start', { dictationId: 'dict-1', modelId }),
          { clientKind: 'mobile' }
        )
      ).toMatchObject({ ok: true })
      expect(runtime.startMobileDictation).toHaveBeenCalledWith(
        expect.objectContaining({ modelId })
      )
    }
  )

  it('does not let an empty legacy selection fall through to a newly selected model', async () => {
    const { dispatcher, runtime } = makeCatalogDispatcher()
    runtime.listMobileSpeechModels.mockResolvedValue({ ...setup, selectedModelId: '' })
    expect(
      await dispatcher.dispatch(makeRequest('speech.dictation.start', { dictationId: 'dict-1' }), {
        clientKind: 'mobile'
      })
    ).toMatchObject({ ok: false, error: { message: 'voice_model_not_selected' } })
    expect(runtime.startMobileDictation).not.toHaveBeenCalled()
  })
})
