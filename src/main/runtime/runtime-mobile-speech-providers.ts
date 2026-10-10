import { getDefaultVoiceSettings } from '../../shared/constants'
import {
  CLOUD_SPEECH_PROVIDERS,
  isCloudSpeechProviderId,
  type CloudSpeechProviderId
} from '../../shared/cloud-speech-providers'
import type {
  RuntimeSpeechProviderKeyTest,
  RuntimeSpeechProviderModel,
  RuntimeSpeechProviderSummary,
  RuntimeSpeechProvidersState
} from '../../shared/runtime-speech-provider-contracts'
import type { SpeechModelManifest, SpeechModelState } from '../../shared/speech-types'
import {
  AUTO_TRANSCRIPTION_LANGUAGE,
  SPEECH_TRANSCRIPTION_LANGUAGES,
  getModelTranscriptionLanguages
} from '../../shared/speech-transcription-languages'
import {
  clearCloudSpeechApiKey,
  getCloudSpeechApiKeyHint,
  hasCloudSpeechApiKey,
  readCloudSpeechApiKey,
  saveCloudSpeechApiKey
} from '../speech/cloud-speech-key-store'
import { saveCloudSpeechApiKeyIfLatest } from '../speech/cloud-speech-key-change-fence'
import { verifyCloudSpeechApiKey } from '../speech/cloud-speech-key-verification'
import { SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { getSpeechModelManager } from '../speech/speech-runtime-service'
import type { RuntimeStore } from './runtime-store-contract'

const LOCAL_PROVIDER_LABEL = 'On-device'
const LOCAL_PROVIDER_DESCRIPTION =
  'Private models that run on your desktop. Download once, no API key.'

function toProviderModel(
  manifest: SpeechModelManifest,
  state: SpeechModelState | undefined
): RuntimeSpeechProviderModel {
  return {
    id: manifest.id,
    label: manifest.label,
    description: manifest.description,
    realtime: manifest.realtime === true,
    languages: getModelTranscriptionLanguages(manifest.transcriptionLanguages),
    sizeBytes: manifest.sizeBytes ?? null,
    recommended: manifest.recommended === true,
    status: state?.status ?? 'not-downloaded',
    progress: state?.progress ?? null
  }
}

function requireProviderId(value: string): CloudSpeechProviderId {
  if (!isCloudSpeechProviderId(value)) {
    throw new Error('voice_provider_unknown')
  }
  return value
}

/** Host side of the mobile voice cabinet: provider keys, key tests and the language hint. */
export class RuntimeMobileSpeechProviders {
  constructor(private readonly getStore: () => RuntimeStore | null) {}

  async list(): Promise<RuntimeSpeechProvidersState> {
    const store = this.requireStore()
    const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
    const states = await getSpeechModelManager(store).getModelStates()
    const stateById = new Map(states.map((state) => [state.id, state]))
    const modelsFor = (providerId: SpeechModelManifest['provider']): RuntimeSpeechProviderModel[] =>
      SPEECH_MODEL_CATALOG.filter((manifest) => manifest.provider === providerId).map((manifest) =>
        toProviderModel(manifest, stateById.get(manifest.id))
      )
    const local: RuntimeSpeechProviderSummary = {
      id: 'local',
      kind: 'local',
      label: LOCAL_PROVIDER_LABEL,
      description: LOCAL_PROVIDER_DESCRIPTION,
      keyConfigured: false,
      keyHint: null,
      keyUrl: null,
      keyPlaceholder: null,
      models: modelsFor('local')
    }
    const cloud = CLOUD_SPEECH_PROVIDERS.map((provider): RuntimeSpeechProviderSummary => {
      const keyConfigured = hasCloudSpeechApiKey(provider.id)
      return {
        id: provider.id,
        kind: 'cloud',
        label: provider.label,
        description: provider.description,
        keyConfigured,
        keyHint: keyConfigured ? getCloudSpeechApiKeyHint(provider.id) : null,
        keyUrl: provider.keyUrl,
        keyPlaceholder: provider.keyPlaceholder,
        models: modelsFor(provider.id)
      }
    })
    return {
      enabled: voice.enabled === true,
      selectedModelId: voice.sttModel ?? '',
      dictationMode: voice.dictationMode === 'hold' ? 'hold' : 'toggle',
      language: voice.transcriptionLanguage || AUTO_TRANSCRIPTION_LANGUAGE,
      providers: [local, ...cloud]
    }
  }

  async saveKey(params: {
    providerId: string
    apiKey: string
    verify?: boolean
  }): Promise<RuntimeSpeechProvidersState> {
    const providerId = requireProviderId(params.providerId)
    this.requireStore()
    const apiKey = params.apiKey.trim()
    if (!apiKey) {
      throw new Error('Missing API key')
    }
    await saveCloudSpeechApiKeyIfLatest(
      providerId,
      async () => {
        if (params.verify === false) {
          return
        }
        const result = await verifyCloudSpeechApiKey(providerId, apiKey)
        if (!result.ok) {
          throw new Error(result.message ?? 'The provider rejected this API key.')
        }
      },
      () => saveCloudSpeechApiKey(providerId, apiKey)
    )
    this.notifyVoiceListeners()
    return this.list()
  }

  async clearKey(params: { providerId: string }): Promise<RuntimeSpeechProvidersState> {
    const providerId = requireProviderId(params.providerId)
    this.requireStore()
    // Why: sttModel stays selected; dictation reports not-ready, which reopens setup on the phone.
    clearCloudSpeechApiKey(providerId)
    this.notifyVoiceListeners()
    return this.list()
  }

  async testKey(params: { providerId: string }): Promise<RuntimeSpeechProviderKeyTest> {
    const providerId = requireProviderId(params.providerId)
    if (!hasCloudSpeechApiKey(providerId)) {
      return { ok: false, message: 'No API key saved.' }
    }
    let apiKey: string
    try {
      apiKey = readCloudSpeechApiKey(providerId)
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
    return verifyCloudSpeechApiKey(providerId, apiKey)
  }

  async configure(params: { language?: string }): Promise<RuntimeSpeechProvidersState> {
    const store = this.requireStore()
    if (params.language !== undefined) {
      if (!SPEECH_TRANSCRIPTION_LANGUAGES.some((entry) => entry.code === params.language)) {
        throw new Error('voice_language_unknown')
      }
      if (!store.updateSettings) {
        throw new Error('voice_dictation_unavailable')
      }
      const current = store.getSettings().voice ?? getDefaultVoiceSettings()
      store.updateSettings(
        { voice: { ...current, transcriptionLanguage: params.language } },
        { notifyListeners: true }
      )
    }
    return this.list()
  }

  private notifyVoiceListeners(): void {
    const store = this.getStore()
    const current = store?.getSettings().voice
    // Why: a new `voice` object is the desktop Voice pane's cue to re-read key and model state.
    if (store?.updateSettings && current) {
      store.updateSettings(
        {
          voice: {
            ...current,
            openAiApiKeyConfigured: hasCloudSpeechApiKey('openai')
          }
        },
        { notifyListeners: true }
      )
    }
  }

  private requireStore(): RuntimeStore {
    const store = this.getStore()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }
    return store
  }
}
