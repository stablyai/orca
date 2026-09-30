import { CUSTOM_STT_MODEL_ID } from './model-catalog'
import {
  readCustomSttEndpointApiKey,
  readCustomSttEndpointConfig,
  resolveCustomSttTranscriptionUrl
} from './custom-stt-endpoint-store'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import {
  OPENAI_TRANSCRIPTION_MODEL_BY_ID,
  OPENAI_TRANSCRIPTION_URL,
  type OpenAiTranscriptionTarget
} from './openai-transcription-client'

/**
 * Map a catalog model id to the concrete HTTP target used by `OpenAiTranscriptionSession`.
 * One resolver keeps `stt-session-start` and the settings "Test" action from drifting.
 */
export function resolveTranscriptionTarget(modelId: string): OpenAiTranscriptionTarget {
  if (modelId === CUSTOM_STT_MODEL_ID) {
    const config = readCustomSttEndpointConfig()
    if (!config) {
      throw new Error('Custom speech endpoint is not configured')
    }
    return {
      url: resolveCustomSttTranscriptionUrl(config.baseUrl),
      apiKey: readCustomSttEndpointApiKey(),
      apiModel: config.model
    }
  }

  const apiModel = OPENAI_TRANSCRIPTION_MODEL_BY_ID[modelId]
  if (!apiModel) {
    throw new Error(`Unknown OpenAI transcription model: ${modelId}`)
  }
  return { url: OPENAI_TRANSCRIPTION_URL, apiKey: readOpenAiSpeechApiKey(), apiModel }
}
