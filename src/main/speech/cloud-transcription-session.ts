import type { SpeechModelProvider } from '../../shared/speech-types'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import { readSonioxSpeechApiKey } from './soniox-api-key-store'
import { SonioxTranscriptionSession } from './soniox-transcription-client'
import type { CloudTranscriptionSession, SttEventSink } from './stt-service-types'

class BufferedOpenAiSession implements CloudTranscriptionSession {
  private readonly session: OpenAiTranscriptionSession

  constructor(modelId: string) {
    this.session = new OpenAiTranscriptionSession(modelId, readOpenAiSpeechApiKey)
  }

  start(): Promise<void> {
    return Promise.resolve()
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    this.session.feedAudio(samples, sampleRate)
  }

  finish(): Promise<string> {
    return this.session.finish()
  }
}

export function createCloudTranscriptionSession(
  modelId: string,
  provider: Exclude<SpeechModelProvider, 'local'>,
  sink: SttEventSink
): CloudTranscriptionSession {
  if (provider === 'openai') {
    return new BufferedOpenAiSession(modelId)
  }
  if (provider === 'soniox') {
    return new SonioxTranscriptionSession(modelId, readSonioxSpeechApiKey, sink)
  }
  const exhaustiveProvider: never = provider
  throw new Error(`Unsupported cloud speech provider: ${exhaustiveProvider}`)
}
