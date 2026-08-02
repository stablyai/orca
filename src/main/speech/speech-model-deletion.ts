import { getDefaultVoiceSettings } from '../../shared/constants'
import type { VoiceSettings } from '../../shared/speech-types'
import { getCatalogModel, isLocalSpeechModel } from './model-catalog'
import type { ModelManager } from './model-manager'
import type { SttService } from './stt-service'

export type SpeechModelDeletionErrorCode =
  | 'voice_model_unknown'
  | 'voice_model_not_deletable'
  | 'voice_model_in_use'

export class SpeechModelDeletionError extends Error {
  constructor(readonly code: SpeechModelDeletionErrorCode) {
    super(code)
    this.name = 'SpeechModelDeletionError'
  }
}

type SpeechModelDeletionStore = {
  getSettings: () => {
    voice?: VoiceSettings
  }
  updateSettings: (
    updates: {
      voice: VoiceSettings
    },
    options?: { notifyListeners?: boolean; originWebContentsId?: number }
  ) => unknown
}

type DeleteLocalSpeechModelArgs = {
  store: SpeechModelDeletionStore
  modelManager: Pick<ModelManager, 'deleteModel'>
  sttService: Pick<SttService, 'prepareModelForDeletion'>
  modelId: string
}

export function getSpeechModelDeletionErrorCode(
  error: unknown
): SpeechModelDeletionErrorCode | null {
  if (error instanceof SpeechModelDeletionError) {
    return error.code
  }
  if (error instanceof Error && error.message === 'voice_model_in_use') {
    return 'voice_model_in_use'
  }
  return null
}

export async function deleteLocalSpeechModel({
  store,
  modelManager,
  sttService,
  modelId
}: DeleteLocalSpeechModelArgs): Promise<void> {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new SpeechModelDeletionError('voice_model_unknown')
  }
  if (!isLocalSpeechModel(manifest)) {
    throw new SpeechModelDeletionError('voice_model_not_deletable')
  }

  await sttService.prepareModelForDeletion(modelId)
  await modelManager.deleteModel(modelId)

  const currentVoice = store.getSettings().voice ?? getDefaultVoiceSettings()
  if (currentVoice.sttModel === modelId) {
    store.updateSettings(
      {
        voice: {
          ...currentVoice,
          sttModel: ''
        }
      },
      { notifyListeners: true }
    )
  }
}
