import type { SpeechModelManifest, SpeechModelState } from '../../shared/speech-types'
import { readAppleSpeechModelState } from './apple-speech-model-state'
import { hasOpenAiSpeechApiKey } from './openai-api-key-store'

/**
 * Models Orca never stores itself: readiness is an API key the user pasted, or
 * speech assets macOS installed and shares with every other app.
 */
export function readProviderManagedModelState(
  manifest: SpeechModelManifest,
  modelId: string
): Promise<SpeechModelState> {
  if (manifest.provider === 'apple') {
    return readAppleSpeechModelState(modelId)
  }
  return Promise.resolve({
    id: modelId,
    status: hasOpenAiSpeechApiKey() ? 'ready' : 'not-downloaded'
  })
}
