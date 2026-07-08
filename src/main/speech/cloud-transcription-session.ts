import type { SpeechModelManifest } from '../../shared/speech-types'
import type { SttEventSink } from './stt-service'
import { OpenAiTranscriptionSession } from './openai-transcription-client'
import { readOpenAiSpeechApiKey } from './openai-api-key-store'
import { SarvamTranscriptionSession } from './sarvam-transcription-client'
import { readSarvamSpeechApiKey } from './sarvam-api-key-store'

// A push-based cloud transcriber: it owns its connection lifecycle and emits
// `partial`/`final`/`error` through the sink. SttService brackets `ready`
// (after start resolves) and `stopped` (after stop resolves).
export type CloudTranscriptionSession = {
  // Resolves once ready to accept audio (Sarvam: WebSocket open; OpenAI:
  // immediately). Rejects on handshake/auth failure so SttService can apply the
  // start timeout and owner-cancel handling.
  start(): Promise<void>
  feedAudio(samples: Float32Array, sampleRate: number): void
  // Flush and emit any trailing finals, then release the connection. Never
  // rejects — provider errors are surfaced as `error` events via the sink.
  stop(): Promise<void>
}

export function createCloudTranscriptionSession(
  manifest: SpeechModelManifest,
  sink: SttEventSink
): CloudTranscriptionSession {
  // Why: dispatch explicitly per provider so a future cloud provider fails fast
  // here instead of silently transcribing against the wrong (OpenAI) API.
  if (manifest.provider === 'sarvam') {
    return new SarvamTranscriptionSession(manifest.id, readSarvamSpeechApiKey, sink)
  }
  if (manifest.provider === 'openai') {
    return new OpenAiTranscriptionSession(manifest.id, readOpenAiSpeechApiKey, sink)
  }
  throw new Error(`Unsupported cloud transcription provider: ${manifest.provider}`)
}
