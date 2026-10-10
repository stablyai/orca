import type { RpcRequest, RpcResponse } from './mock-server-rpc-handlers'
import { CLOUD_SPEECH_PROVIDERS } from '../../src/shared/cloud-speech-providers'
import {
  getModelTranscriptionLanguages,
  VOXTRAL_TRANSCRIPTION_LANGUAGES
} from '../../src/shared/speech-transcription-languages'
import type {
  RuntimeSpeechProviderModel,
  RuntimeSpeechProviderSummary,
  RuntimeSpeechProvidersState
} from '../../src/shared/runtime-speech-provider-contracts'

type Respond = (response: RpcResponse) => void
type Success = (id: string, result: unknown) => RpcResponse
type ErrorResponse = (id: string, code: string, message: string) => RpcResponse

type MockModel = Omit<RuntimeSpeechProviderModel, 'status' | 'progress'> & { providerId: string }

const ALL_LANGUAGES = getModelTranscriptionLanguages('any') ?? []
// Why: mirrors the desktop catalog ids so simulator screenshots match what a real host lists.
const MOCK_MODELS: MockModel[] = [
  local('parakeet-tdt-0.6b-v3-int8', 'Parakeet TDT v3', 670_000_000, true),
  local('whisper-tiny', 'Whisper Tiny', 75_000_000, false),
  local('sense-voice-zh-en-ja-ko-yue', 'SenseVoice', 230_000_000, false),
  cloud('soniox', 'soniox-stt-rt-v5', 'Soniox Real-time v5', true),
  cloud('elevenlabs', 'elevenlabs-scribe-v2-realtime', 'Scribe v2 Real-time', true),
  cloud('elevenlabs', 'elevenlabs-scribe-v2', 'Scribe v2', false),
  cloud('deepgram', 'deepgram-nova-3', 'Nova-3', true),
  cloud('gemini', 'gemini-flash-latest', 'Gemini Flash (latest)', false),
  cloud('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', false),
  cloud('openai', 'openai-gpt-4o-mini-transcribe', 'GPT-4o mini Transcribe', false),
  cloud('openai', 'openai-gpt-4o-transcribe', 'GPT-4o Transcribe', false),
  cloud('groq', 'groq-whisper-large-v3-turbo', 'Whisper Large v3 Turbo', false),
  cloud('groq', 'groq-whisper-large-v3', 'Whisper Large v3', false),
  cloud('mistral', 'mistral-voxtral-mini', 'Voxtral Mini', false, [
    ...VOXTRAL_TRANSCRIPTION_LANGUAGES
  ])
]

const MOCK_TRANSCRIPT =
  'Refactor the speech settings so every provider gets its own screen and make the live captions follow the newest words'

function local(id: string, label: string, sizeBytes: number, recommended: boolean): MockModel {
  const description = 'Runs on your desktop. No API key.'
  return {
    providerId: 'local',
    id,
    label,
    description,
    realtime: false,
    languages: null,
    sizeBytes,
    recommended
  }
}

function cloud(
  providerId: string,
  id: string,
  label: string,
  realtime: boolean,
  languages: string[] = ALL_LANGUAGES
): MockModel {
  const description = realtime ? 'Live captions while you speak.' : 'Transcribes after you stop.'
  return {
    providerId,
    id,
    label,
    description,
    realtime,
    languages,
    sizeBytes: null,
    recommended: false
  }
}

type MockSpeechState = {
  enabled: boolean
  selectedModelId: string
  dictationMode: 'toggle' | 'hold'
  language: string
  downloaded: Set<string>
  downloads: Map<string, number>
  keyHints: Map<string, string>
  dictations: Map<string, { bytes: number; revision: number; text: string }>
}

const state: MockSpeechState = {
  enabled: true,
  selectedModelId: 'soniox-stt-rt-v5',
  dictationMode: 'toggle',
  language: 'auto',
  downloaded: new Set(['parakeet-tdt-0.6b-v3-int8', 'whisper-tiny']),
  downloads: new Map<string, number>(),
  keyHints: new Map<string, string>([['soniox', '…a1b2']]),
  dictations: new Map<string, { bytes: number; revision: number; text: string }>()
}

function modelStatus(model: MockModel): Pick<RuntimeSpeechProviderModel, 'status' | 'progress'> {
  if (model.providerId !== 'local') {
    return {
      status: state.keyHints.has(model.providerId) ? 'ready' : 'not-downloaded',
      progress: null
    }
  }
  const progress = state.downloads.get(model.id)
  if (progress !== undefined) {
    return { status: 'downloading', progress }
  }
  return { status: state.downloaded.has(model.id) ? 'ready' : 'not-downloaded', progress: null }
}

function providerModels(providerId: string): RuntimeSpeechProviderModel[] {
  return MOCK_MODELS.filter((model) => model.providerId === providerId).map(
    ({ providerId: _providerId, ...model }) => ({
      ...model,
      ...modelStatus({ providerId, ...model })
    })
  )
}

function providersState(): RuntimeSpeechProvidersState {
  const providers: RuntimeSpeechProviderSummary[] = [
    {
      id: 'local',
      kind: 'local',
      label: 'On-device',
      description: 'Private models that run on your desktop. Download once, no API key.',
      keyConfigured: false,
      keyHint: null,
      keyUrl: null,
      keyPlaceholder: null,
      models: providerModels('local')
    },
    ...CLOUD_SPEECH_PROVIDERS.map((info) => ({
      id: info.id,
      kind: 'cloud' as const,
      label: info.label,
      description: info.description,
      keyConfigured: state.keyHints.has(info.id),
      keyHint: state.keyHints.get(info.id) ?? null,
      keyUrl: info.keyUrl,
      keyPlaceholder: info.keyPlaceholder,
      models: providerModels(info.id)
    }))
  ]
  const { enabled, selectedModelId, dictationMode, language } = state
  return { enabled, selectedModelId, dictationMode, language, providers }
}

// `speech.models.list` keeps answering local + OpenAI rows only, like the real host.
function legacySetup() {
  const models = MOCK_MODELS.filter((m) => m.providerId === 'local' || m.providerId === 'openai')
  return {
    enabled: state.enabled,
    selectedModelId: state.selectedModelId,
    dictationMode: state.dictationMode,
    models: models.map(({ providerId, ...model }) => ({
      ...model,
      provider: providerId,
      ...modelStatus({ providerId, ...model })
    }))
  }
}

function startMockDownload(modelId: string): void {
  state.downloads.set(modelId, 0)
  const timer = setInterval(() => {
    const next = (state.downloads.get(modelId) ?? 0) + 0.1
    if (next >= 1) {
      clearInterval(timer)
      state.downloads.delete(modelId)
      state.downloaded.add(modelId)
      return
    }
    state.downloads.set(modelId, next)
  }, 400)
}

function captionFor(audioBytes: number): string {
  // 16 kHz PCM16 = 32 000 bytes per second; about 2.5 words per second of speech.
  const words = MOCK_TRANSCRIPT.split(' ')
  return words.slice(0, Math.floor((audioBytes / 32_000) * 2.5)).join(' ')
}

function selectedMockModel(): MockModel | undefined {
  return MOCK_MODELS.find((model) => model.id === state.selectedModelId)
}

function handleProviderKey(
  request: RpcRequest,
  respond: Respond,
  ok: Success,
  fail: ErrorResponse
) {
  const providerId = String(request.params?.providerId ?? '')
  const info = CLOUD_SPEECH_PROVIDERS.find((entry) => entry.id === providerId)
  if (!info) {
    respond(fail(request.id, 'invalid_argument', 'voice_provider_unknown'))
    return
  }
  if (request.method === 'speech.providers.saveKey') {
    const apiKey = String(request.params?.apiKey ?? '')
    // Why: lets the simulator demo the rejection path; type a key containing "bad".
    if (apiKey.length < 8 || apiKey.includes('bad')) {
      respond(fail(request.id, 'internal_error', `${info.label} rejected this API key (401).`))
      return
    }
    state.keyHints.set(providerId, `…${apiKey.slice(-4)}`)
  } else if (request.method === 'speech.providers.clearKey') {
    state.keyHints.delete(providerId)
  } else {
    const configured = state.keyHints.has(providerId)
    respond(ok(request.id, { ok: configured, message: configured ? null : 'No API key saved.' }))
    return
  }
  respond(ok(request.id, providersState()))
}

export function handleMockSpeechRequest(
  request: RpcRequest,
  respond: Respond,
  success: Success,
  error: ErrorResponse
): boolean {
  const params = request.params ?? {}
  switch (request.method) {
    case 'speech.models.list':
      respond(success(request.id, legacySetup()))
      return true
    case 'speech.dictation.setup':
      if (typeof params.enabled === 'boolean') {
        state.enabled = params.enabled
      }
      if (typeof params.modelId === 'string') {
        state.selectedModelId = params.modelId
      }
      if (params.dictationMode === 'toggle' || params.dictationMode === 'hold') {
        state.dictationMode = params.dictationMode
      }
      respond(success(request.id, legacySetup()))
      return true
    case 'speech.models.download':
      startMockDownload(String(params.modelId))
      respond(success(request.id, { started: true }))
      return true
    case 'speech.models.delete':
      state.downloaded.delete(String(params.modelId))
      respond(success(request.id, legacySetup()))
      return true
    case 'speech.providers.list':
      respond(success(request.id, providersState()))
      return true
    case 'speech.providers.configure':
      if (typeof params.language === 'string') {
        state.language = params.language
      }
      respond(success(request.id, providersState()))
      return true
    case 'speech.providers.saveKey':
    case 'speech.providers.clearKey':
    case 'speech.providers.testKey':
      handleProviderKey(request, respond, success, error)
      return true
    case 'speech.dictation.start': {
      const model = selectedMockModel()
      if (!state.enabled || !model || modelStatus(model).status !== 'ready') {
        respond(
          error(request.id, 'internal_error', `voice_model_not_ready:${state.selectedModelId}`)
        )
        return true
      }
      state.dictations.set(String(params.dictationId), { bytes: 0, revision: 0, text: '' })
      respond(success(request.id, { dictationId: params.dictationId }))
      return true
    }
    case 'speech.dictation.chunk': {
      const dictationId = String(params.dictationId)
      const session = state.dictations.get(dictationId)
      if (!session) {
        respond(error(request.id, 'internal_error', 'voice_dictation_not_found'))
        return true
      }
      session.bytes += Math.floor((String(params.audioBase64 ?? '').length * 3) / 4)
      const text = selectedMockModel()?.realtime ? captionFor(session.bytes) : ''
      if (text !== session.text) {
        session.text = text
        session.revision += 1
      }
      const caption = text ? { text, revision: session.revision } : undefined
      respond(success(request.id, { dictationId, ...(caption ? { caption } : {}) }))
      return true
    }
    case 'speech.dictation.finish': {
      const session = state.dictations.get(String(params.dictationId))
      state.dictations.delete(String(params.dictationId))
      const text = session ? captionFor(session.bytes) || MOCK_TRANSCRIPT : ''
      respond(success(request.id, { dictationId: params.dictationId, text }))
      return true
    }
    case 'speech.dictation.cancel':
      state.dictations.delete(String(params.dictationId))
      respond(success(request.id, { cancelled: true }))
      return true
    default:
      return false
  }
}
