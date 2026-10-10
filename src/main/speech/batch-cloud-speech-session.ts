import { BatchDictationAudioBuffer, type BatchAudioLimit } from './cloud-speech-audio-encoding'
import type { CloudSpeechSession } from './cloud-speech-session'
import {
  CLOUD_SPEECH_REQUEST_TIMEOUT_MS,
  describeProviderFailure
} from './cloud-speech-provider-errors'

export type BatchTranscriptionRequest = {
  wav: Buffer
  apiKey: string
  language: string | undefined
  signal: AbortSignal
}

export type BatchTranscribe = (request: BatchTranscriptionRequest) => Promise<string>

/** Buffers a dictation and uploads it once on finish; providers supply only the HTTP call. */
export class BatchCloudSpeechSession implements CloudSpeechSession {
  private readonly audio: BatchDictationAudioBuffer
  private readonly abort = new AbortController()

  constructor(
    private readonly label: string,
    private readonly transcribe: BatchTranscribe,
    private readonly readApiKey: () => string,
    private readonly language: string | undefined,
    limit?: BatchAudioLimit
  ) {
    this.audio = new BatchDictationAudioBuffer(limit)
  }

  feedAudio(samples: Float32Array, sampleRate: number): void {
    this.audio.append(samples, sampleRate)
  }

  async finish(): Promise<string> {
    if (this.audio.isEmpty()) {
      return ''
    }
    const wav = this.audio.takeWav()
    // Why: read lazily so an unused session never decrypts the key (keychain prompt).
    const apiKey = this.readApiKey()
    try {
      const text = await this.transcribe({
        wav,
        apiKey,
        language: this.language,
        signal: AbortSignal.any([
          this.abort.signal,
          AbortSignal.timeout(CLOUD_SPEECH_REQUEST_TIMEOUT_MS)
        ])
      })
      return text.trim()
    } catch (error) {
      // Why: a cancel is not a failure the user should read; callers drop canceled sessions.
      if (this.abort.signal.aborted) {
        throw error
      }
      // Why: a timeout surfaces as a raw DOMException ("The operation was aborted due to timeout").
      throw new Error(describeProviderFailure(this.label, error))
    }
  }

  cancel(): void {
    this.audio.clear()
    this.abort.abort()
  }
}

export function wavBlob(wav: Buffer): Blob {
  return new Blob([new Uint8Array(wav)], { type: 'audio/wav' })
}
