import type { VoiceSettings } from '../../shared/speech-types'
import type { RuntimeSpeechModelSummary, RuntimeSpeechSetupState } from '../../shared/runtime-types'
import { getDefaultVoiceSettings } from '../../shared/constants'
import { getCatalogModel, isLocalSpeechModel, SPEECH_MODEL_CATALOG } from '../speech/model-catalog'
import { getSpeechModelManager, getSpeechSttService } from '../speech/speech-runtime-service'
import { hasLocalSpeechRecognizer } from '../speech/stt-worker-paths'
import {
  deleteLocalSpeechModel,
  getSpeechModelDeletionErrorCode
} from '../speech/speech-model-deletion'
import type { RuntimeStore } from './runtime-store-contract'
import {
  clearOpenAiSpeechApiKey,
  getOpenAiSpeechApiKeyProtection,
  hasOpenAiSpeechApiKey,
  saveOpenAiSpeechApiKey
} from '../speech/openai-api-key-store'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'

export type OpenAiSpeechKeyStatus = {
  configured: boolean
  protection: SecretAtRestProtection | null
}

export class RuntimeMobileSpeechCatalog {
  constructor(private readonly getStore: () => RuntimeStore | null) {}

  async list(): Promise<RuntimeSpeechSetupState> {
    const store = this.requireStore()
    const voice = store.getSettings().voice ?? getDefaultVoiceSettings()
    const states = await getSpeechModelManager(store).getModelStates()
    const stateById = new Map(states.map((state) => [state.id, state]))
    // Omit unsupported status variants; older phones could treat them as pickable models.
    const runnable = hasLocalSpeechRecognizer()
      ? SPEECH_MODEL_CATALOG
      : SPEECH_MODEL_CATALOG.filter((manifest) => !isLocalSpeechModel(manifest))
    const models: RuntimeSpeechModelSummary[] = runnable.map((manifest) => {
      const state = stateById.get(manifest.id)
      return {
        id: manifest.id,
        label: manifest.label,
        provider: manifest.provider === 'openai' ? 'openai' : 'local',
        sizeBytes: manifest.sizeBytes ?? null,
        recommended: manifest.recommended === true,
        status: state?.status ?? 'not-downloaded',
        progress: state?.progress ?? null
      }
    })
    return {
      enabled: voice.enabled === true,
      selectedModelId: voice.sttModel ?? '',
      dictationMode: voice.dictationMode === 'hold' ? 'hold' : 'toggle',
      models
    }
  }

  async download(modelId: string): Promise<{ started: true }> {
    const store = this.requireStore()
    const manifest = getCatalogModel(modelId)
    if (!manifest || !isLocalSpeechModel(manifest) || !hasLocalSpeechRecognizer()) {
      throw new Error('voice_model_not_downloadable')
    }
    void getSpeechModelManager(store)
      .downloadModel(modelId)
      .catch((err) =>
        console.error('[runtime] mobile speech model download failed', { modelId, err })
      )
    return { started: true }
  }

  async delete(modelId: string): Promise<RuntimeSpeechSetupState> {
    const store = this.requireWritableStore()
    try {
      await deleteLocalSpeechModel({
        store: {
          getSettings: () => store.getSettings(),
          updateSettings: (updates, options) => store.updateSettings?.(updates, options)
        },
        modelManager: getSpeechModelManager(store),
        sttService: getSpeechSttService(store),
        modelId
      })
    } catch (error) {
      throw new Error(getSpeechModelDeletionErrorCode(error) ?? 'voice_model_delete_failed')
    }
    return this.list()
  }

  async configure(params: {
    enabled?: boolean
    modelId?: string
    dictationMode?: 'toggle' | 'hold'
  }): Promise<RuntimeSpeechSetupState> {
    const store = this.requireWritableStore()
    const current = store.getSettings().voice ?? getDefaultVoiceSettings()
    if (params.modelId !== undefined && params.modelId !== '' && !getCatalogModel(params.modelId)) {
      throw new Error('voice_model_unknown')
    }
    const nextVoice: VoiceSettings = {
      ...current,
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
      ...(params.modelId !== undefined ? { sttModel: params.modelId } : {}),
      ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
    }
    store.updateSettings?.({ voice: nextVoice }, { notifyListeners: true })
    return this.list()
  }

  /** Set cloud dictation keys over RPC for headless hosts without Settings; seal with the transcribing host's secret store. */
  openAiKeyStatus(): OpenAiSpeechKeyStatus {
    return { configured: hasOpenAiSpeechApiKey(), protection: getOpenAiSpeechApiKeyProtection() }
  }

  setOpenAiKey(apiKey: string): OpenAiSpeechKeyStatus {
    saveOpenAiSpeechApiKey(apiKey)
    return this.openAiKeyStatus()
  }

  clearOpenAiKey(): OpenAiSpeechKeyStatus {
    clearOpenAiSpeechApiKey()
    return this.openAiKeyStatus()
  }

  private requireStore(): RuntimeStore {
    const store = this.getStore()
    if (!store) {
      throw new Error('voice_dictation_unavailable')
    }
    return store
  }

  private requireWritableStore(): RuntimeStore {
    const store = this.requireStore()
    if (!store.getSettings || !store.updateSettings) {
      throw new Error('voice_dictation_unavailable')
    }
    return store
  }
}
