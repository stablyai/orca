import { ModelManager } from './model-manager'
import { SttService } from './stt-service'
import type { VoiceSettings } from '../../shared/speech-types'

type SpeechSettingsStore = {
  getSettings(): {
    voice?: VoiceSettings
  }
}

let modelManager: ModelManager | null = null
let sttService: SttService | null = null

export function getSpeechModelManager(store: SpeechSettingsStore): ModelManager {
  if (!modelManager) {
    const settings = store.getSettings()
    const customDir = settings.voice?.modelsDir || undefined
    modelManager = new ModelManager(customDir || undefined)
  }
  return modelManager
}

export function getSpeechSttService(store: SpeechSettingsStore): SttService {
  if (!sttService) {
    sttService = new SttService(getSpeechModelManager(store))
  }
  return sttService
}
