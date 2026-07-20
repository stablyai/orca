import { getDefaultVoiceSettings } from '../../shared/constants'
import type { Store } from '../persistence/loading-store/store'
import { SPEECH_MODEL_CATALOG } from './model-catalog'
import { getSupportedSpeechModelSelection } from './speech-platform-support'

export function reconcileUnsupportedSpeechSettings(
  store: Store,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch
): boolean {
  const currentVoice = store.getSettings().voice ?? getDefaultVoiceSettings()
  const selectedModelId = getSupportedSpeechModelSelection(
    currentVoice.sttModel,
    SPEECH_MODEL_CATALOG,
    platform,
    architecture
  )
  if (selectedModelId === currentVoice.sttModel) {
    return false
  }
  // Clear saved local models when this host has no speech-engine build.
  store.updateSettings(
    { voice: { ...currentVoice, sttModel: selectedModelId } },
    { notifyListeners: true }
  )
  return true
}
