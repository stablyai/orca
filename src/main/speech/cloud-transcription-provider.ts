import type { CloudTranscriptionSession } from './cloud-transcription-session'
import { ElevenLabsTranscriptionSession } from './elevenlabs-transcription-client'
import { readElevenLabsSpeechApiKey } from './elevenlabs-api-key-store'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'

export type CloudSpeechProvider = 'openai' | 'elevenlabs'

/**
 * Why: dictation must not care which cloud provider is selected — the session lifecycle only
 * sees `CloudTranscriptionSession`. Every provider is constructed here so adding one is a single
 * switch, and the key store each client reads stays explicit at the call site.
 */
export function createCloudTranscriptionSession(
  modelId: string,
  provider: CloudSpeechProvider
): CloudTranscriptionSession {
  switch (provider) {
    case 'openai':
      return new OpenAiTranscriptionSession(modelId, readOpenAiSpeechApiKey)
    case 'elevenlabs':
      return new ElevenLabsTranscriptionSession(modelId, readElevenLabsSpeechApiKey)
  }
}
