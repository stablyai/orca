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
    // Why: read at dictation time, not construction, so settings edits apply
    // to the next session without restarting the app.
    sttService = new SttService(
      getSpeechModelManager(store),
      () => store.getSettings().voice?.transcriptionLanguage
    )
  }
  return sttService
}
