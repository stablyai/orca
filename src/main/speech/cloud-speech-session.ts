import type { SttEventSink } from './stt-service'

/** A cloud dictation in flight: batch sessions buffer audio, realtime ones stream it. */
export type CloudSpeechSession = {
  feedAudio(samples: Float32Array, sampleRate: number): void
  /** Resolves with the whole final transcript; stt-session-stop emits it as one 'final'. */
  finish(): Promise<string>
  /** Drops the session without waiting for the provider. */
  cancel(): void
}

export type CloudSpeechSessionOptions = {
  readApiKey: () => string
  /** ISO 639-1 hint, or undefined to let the provider auto-detect. */
  language?: string
  sink: SttEventSink
}

export const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16000
