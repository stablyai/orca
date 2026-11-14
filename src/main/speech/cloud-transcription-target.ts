import type { SpeechModelProvider } from '../../shared/speech-types'
import { getCatalogModel, replaceRetiredSpeechModelId } from './model-catalog'
import {
  canReadOpenAiSpeechApiKey,
  hasOpenAiSpeechApiKey,
  readOpenAiSpeechApiKey
} from './openai-api-key-store'
import {
  canReadOpenAiCompatibleSpeechProvider,
  hasOpenAiCompatibleSpeechProvider,
  openAiCompatibleTranscriptionUrl,
  readOpenAiCompatibleSpeechProvider
} from './openai-compatible-speech-provider-store'

export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'

const OPENAI_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'openai-gpt-transcribe': 'gpt-transcribe'
}

export type CloudTranscriptionTarget = {
  url: string
  model: string
  /** Empty when the server takes no key. */
  apiKey: string
  /** Names the service in errors. */
  label: string
}

export function hasCloudSpeechCredentials(provider: SpeechModelProvider): boolean {
  return provider === 'openai-compatible'
    ? hasOpenAiCompatibleSpeechProvider()
    : hasOpenAiSpeechApiKey()
}

/** Headless hosts can't raise keychain prompts, so their readiness verifies decryption. */
export function canReadCloudSpeechCredentials(provider: SpeechModelProvider): boolean {
  return provider === 'openai-compatible'
    ? canReadOpenAiCompatibleSpeechProvider()
    : canReadOpenAiSpeechApiKey()
}

/** Reads the key (and the compatible provider's URL) only when audio is ready to upload. */
export function resolveCloudTranscriptionTarget(modelId: string): CloudTranscriptionTarget {
  if (getCatalogModel(modelId)?.provider === 'openai-compatible') {
    const provider = readOpenAiCompatibleSpeechProvider()
    if (!provider) {
      throw new Error('The OpenAI-compatible speech provider is not set up')
    }
    const url = openAiCompatibleTranscriptionUrl(provider.baseUrl)
    return { url, model: provider.model, apiKey: provider.apiKey, label: new URL(url).host }
  }
  // Settings load already moves retired ids; this catches a caller still holding one.
  const model = OPENAI_TRANSCRIPTION_MODEL_BY_ID[replaceRetiredSpeechModelId(modelId)]
  if (!model) {
    throw new Error(`Unknown OpenAI transcription model: ${modelId}`)
  }
  return { url: OPENAI_TRANSCRIPTION_URL, model, apiKey: readOpenAiSpeechApiKey(), label: 'OpenAI' }
}
