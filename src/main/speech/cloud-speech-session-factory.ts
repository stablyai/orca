import type { SpeechModelManifest } from '../../shared/speech-types'
import { BatchCloudSpeechSession, type BatchTranscribe } from './batch-cloud-speech-session'
import { getCloudSpeechApiModel } from './cloud-speech-model-catalog'
import type { CloudSpeechSession, CloudSpeechSessionOptions } from './cloud-speech-session'
import { DeepgramRealtimeSession } from './deepgram-realtime-session'
import { ElevenLabsRealtimeSession } from './elevenlabs-realtime-session'
import { createElevenLabsTranscribe } from './elevenlabs-transcription-client'
import { createGeminiTranscribe, GEMINI_BATCH_AUDIO_LIMIT } from './gemini-transcription-client'
import { createMistralTranscribe } from './mistral-transcription-client'
import {
  GROQ_API_BASE_URL,
  OpenAiTranscriptionSession,
  createOpenAiCompatibleTranscribe
} from './openai-transcription-client'
import type { RealtimeCloudSpeechSession } from './realtime-cloud-speech-session'
import { SonioxRealtimeSession } from './soniox-realtime-session'

function createRealtimeSession(
  manifest: SpeechModelManifest,
  apiModel: string,
  options: CloudSpeechSessionOptions
): RealtimeCloudSpeechSession | null {
  switch (manifest.provider) {
    case 'soniox':
      return new SonioxRealtimeSession(apiModel, options)
    case 'elevenlabs':
      return new ElevenLabsRealtimeSession(apiModel, options)
    case 'deepgram':
      return new DeepgramRealtimeSession(apiModel, options)
    case 'gemini':
    case 'groq':
    case 'mistral':
    case 'openai':
    case 'local':
      return null
  }
}

type BatchClient = { label: string; transcribe: BatchTranscribe }

function createBatchClient(manifest: SpeechModelManifest, apiModel: string): BatchClient | null {
  switch (manifest.provider) {
    case 'groq':
      return {
        label: 'Groq',
        transcribe: createOpenAiCompatibleTranscribe({
          label: 'Groq',
          baseUrl: GROQ_API_BASE_URL,
          apiModel
        })
      }
    case 'elevenlabs':
      return { label: 'ElevenLabs', transcribe: createElevenLabsTranscribe(apiModel) }
    case 'gemini':
      return { label: 'Gemini', transcribe: createGeminiTranscribe(apiModel) }
    case 'mistral':
      return { label: 'Mistral', transcribe: createMistralTranscribe(apiModel) }
    case 'soniox':
    case 'deepgram':
    case 'openai':
    case 'local':
      return null
  }
}

/** Builds the provider session for a cloud catalog model; realtime sockets open immediately. */
export function createCloudSpeechSession(
  manifest: SpeechModelManifest,
  options: CloudSpeechSessionOptions
): CloudSpeechSession {
  if (manifest.provider === 'openai') {
    return new OpenAiTranscriptionSession(manifest.id, options.readApiKey, {
      language: options.language
    })
  }
  const apiModel = getCloudSpeechApiModel(manifest.id)
  if (!apiModel || manifest.provider === 'local') {
    throw new Error(`Unknown cloud speech model: ${manifest.id}`)
  }
  if (manifest.realtime) {
    const session = createRealtimeSession(manifest, apiModel, options)
    if (!session) {
      throw new Error(`No real-time client for ${manifest.provider}`)
    }
    session.start()
    return session
  }
  const client = createBatchClient(manifest, apiModel)
  if (!client) {
    throw new Error(`No batch client for ${manifest.provider}`)
  }
  return new BatchCloudSpeechSession(
    client.label,
    client.transcribe,
    options.readApiKey,
    options.language,
    manifest.provider === 'gemini' ? GEMINI_BATCH_AUDIO_LIMIT : undefined
  )
}
