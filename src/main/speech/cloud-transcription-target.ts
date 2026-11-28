import type { SpeechModelProvider } from '../../shared/speech/speech-types'
import { getCatalogModel, replaceRetiredSpeechModelId } from './model-catalog'
import {
  canReadOpenAiSpeechApiKey,
  hasOpenAiSpeechApiKey,
  readOpenAiSpeechApiKey
} from './openai-api-key-store'
import {
  canReadOpenAiCompatibleSpeechProvider,
  hasOpenAiCompatibleSpeechProvider,
  readOpenAiCompatibleSpeechProvider
} from './openai-compatible-speech-provider-store'
import { openAiCompatibleTranscriptionUrl } from '../../shared/speech/openai-compatible-endpoint'

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

export async function hasCloudSpeechCredentials(provider: SpeechModelProvider): Promise<boolean> {
  return provider === 'openai-compatible'
    ? await hasOpenAiCompatibleSpeechProvider()
    : await hasOpenAiSpeechApiKey()
}

/** Headless hosts can't raise keychain prompts, so their readiness verifies decryption. */
export async function canReadCloudSpeechCredentials(
  provider: SpeechModelProvider
): Promise<boolean> {
  return provider === 'openai-compatible'
    ? await canReadOpenAiCompatibleSpeechProvider()
    : await canReadOpenAiSpeechApiKey()
}

/** Reads the key (and the compatible provider's URL) only when audio is ready to upload. */
export async function resolveCloudTranscriptionTarget(
  modelId: string
): Promise<CloudTranscriptionTarget> {
  if (getCatalogModel(modelId)?.provider === 'openai-compatible') {
    const provider = await readOpenAiCompatibleSpeechProvider()
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
  return {
    url: OPENAI_TRANSCRIPTION_URL,
    model,
    apiKey: await readOpenAiSpeechApiKey(),
    label: 'OpenAI'
  }
}
