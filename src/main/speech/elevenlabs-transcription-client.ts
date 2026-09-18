import type { CloudTranscriptionSession } from './cloud-transcription-session'
import { resampleToRate } from './stt-audio-resample'
import {
  CLOUD_TRANSCRIPTION_SAMPLE_RATE,
  MAX_CLOUD_AUDIO_SECONDS,
  combineFloat32Chunks,
  encodePcm16Wav
} from './cloud-transcription-audio'
import {
  describeCloudTranscriptionNetworkFailure,
  redactTranscriptionSecrets
} from './cloud-transcription-errors'

export const ELEVENLABS_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'elevenlabs-scribe-v2': 'scribe_v2'
}

// Why: `scribe_v1` is deprecated by the provider; the catalog and this map only ship v2 so a
// stale model id can never reach the API.
const ELEVENLABS_TRANSCRIPTION_URL = 'https://api.elevenlabs.io/v1/speech-to-text'
const ELEVENLABS_INVALID_KEY_PATTERN = /invalid api key|api key[^.]*(?:invalid|incorrect)|unauthorized/i

function readElevenLabsTranscriptText(payload: unknown): string | null {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('text' in payload) ||
    typeof payload.text !== 'string'
  ) {
    return null
  }
  return payload.text.trim()
}

function readElevenLabsErrorDetail(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object' || !('detail' in payload)) {
    return null
  }
  return extractElevenLabsErrorDetail(payload.detail)
}

function extractElevenLabsErrorDetail(detail: unknown): string | null {
  if (typeof detail === 'string') {
    return detail
  }
  if (Array.isArray(detail)) {
    // Why: ElevenLabs answers FastAPI-shaped validation errors as `detail: [{ msg }]`.
    for (const entry of detail) {
      if (entry !== null && typeof entry === 'object' && 'msg' in entry && typeof entry.msg === 'string') {
        return entry.msg
      }
    }
    return null
  }
  if (detail !== null && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string') {
    return detail.message
  }
  return null
}

export function sanitizeElevenLabsTranscriptionErrorMessage(message: string): string {
  if (ELEVENLABS_INVALID_KEY_PATTERN.test(message)) {
    return 'Incorrect ElevenLabs API key provided.'
  }

  const sanitized = redactTranscriptionSecrets(message)
  return sanitized || 'ElevenLabs transcription request failed'
}

export class ElevenLabsTranscriptionSession implements CloudTranscriptionSession {
  private chunks: Float32Array[] = []
  private audioSeconds = 0

  constructor(
    private readonly modelId: string,
    private readonly readApiKey: () => string
  ) {}

  feedAudio(samples: Float32Array, sampleRate: number): void {
    const normalized = resampleToRate(samples, sampleRate, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    this.audioSeconds += normalized.length / CLOUD_TRANSCRIPTION_SAMPLE_RATE
    if (this.audioSeconds > MAX_CLOUD_AUDIO_SECONDS) {
      throw new Error('Cloud transcription is limited to 10 minutes per dictation')
    }
    this.chunks.push(new Float32Array(normalized))
  }

  async finish(): Promise<string> {
    if (this.chunks.length === 0) {
      return ''
    }

    const apiModel = ELEVENLABS_TRANSCRIPTION_MODEL_BY_ID[this.modelId]
    if (!apiModel) {
      throw new Error(`Unknown ElevenLabs transcription model: ${this.modelId}`)
    }

    const audio = combineFloat32Chunks(this.chunks)
    this.chunks = []
    const wav = encodePcm16Wav(audio, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const form = new FormData()
    form.append('model_id', apiModel)
    // Why: a named WAV blob matches the provider's multipart contract without temp files, and
    // the bytes are byte-identical to what the OpenAI client uploads.
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav')

    let response: Response
    try {
      response = await fetch(ELEVENLABS_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: {
          'xi-api-key': this.readApiKey()
        },
        body: form
      })
    } catch (error) {
      throw new Error(describeCloudTranscriptionNetworkFailure(error, 'ElevenLabs'))
    }

    const payload: unknown = await response.json().catch(() => null)
    const detail = readElevenLabsErrorDetail(payload)
    if (!response.ok) {
      const message = detail
        ? sanitizeElevenLabsTranscriptionErrorMessage(detail)
        : response.statusText
      throw new Error(`ElevenLabs transcription failed: ${message}`)
    }

    const text = readElevenLabsTranscriptText(payload)
    if (text !== null) {
      return text
    }
    if (detail) {
      throw new Error(sanitizeElevenLabsTranscriptionErrorMessage(detail))
    }
    throw new Error('ElevenLabs transcription response did not include text')
  }
}
