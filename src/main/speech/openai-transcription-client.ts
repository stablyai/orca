import { resampleToRate } from './stt-audio-resample'

export const OPENAI_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'openai-gpt-4o-mini-transcribe': 'gpt-4o-mini-transcribe',
  'openai-gpt-4o-transcribe': 'gpt-4o-transcribe'
}

export const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16000
const MAX_CLOUD_AUDIO_SECONDS = 10 * 60
const TRANSCRIPTION_TIMEOUT_MS = 120_000

/**
 * Resolved POST target for an OpenAI-shaped transcription request.
 *
 * `readApiKey` is a getter, not a value, so the secret is read only when a request
 * is actually made (an empty dictation never touches the keychain). The URL/model/
 * language are snapshotted when the session starts, so a settings change mid-dictation
 * cannot re-route the buffered audio.
 */
export type OpenAiTranscriptionTarget = {
  url: string
  apiModel: string
  readApiKey: () => string | null
  /** ISO-639 language hint for the multipart `language` field; undefined = auto-detect. */
  language?: string
}

type OpenAiTranscriptionResponse = {
  text?: unknown
  error?: {
    message?: unknown
  }
}

export function sanitizeOpenAiTranscriptionErrorMessage(message: string): string {
  if (/incorrect api key provided:/i.test(message)) {
    return 'Incorrect OpenAI API key provided.'
  }

  const sanitized = message
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()

  return sanitized || 'OpenAI transcription request failed'
}

function encodePcm16Wav(samples: Float32Array, sampleRate: number): Buffer {
  const dataBytes = samples.length * 2
  const buffer = Buffer.alloc(44 + dataBytes)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)

  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(value), 44 + i * 2)
  }

  return buffer
}

function combineChunks(chunks: Float32Array[]): Float32Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Float32Array(totalLength)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

function parseOpenAiTranscriptionResponse(data: OpenAiTranscriptionResponse): string {
  if (typeof data.text === 'string') {
    return data.text.trim()
  }
  if (typeof data.error?.message === 'string') {
    throw new Error(sanitizeOpenAiTranscriptionErrorMessage(data.error.message))
  }
  throw new Error('OpenAI transcription response did not include text')
}

export class OpenAiTranscriptionSession {
  private chunks: Float32Array[] = []
  private audioSeconds = 0

  /**
   * The destination is fixed for the whole recording. Why: resolving it lazily at
   * finish would let a settings change mid-dictation re-route the buffered audio to
   * a different server (or none, if the endpoint was disconnected), losing the clip.
   */
  constructor(private readonly target: OpenAiTranscriptionTarget) {}

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

    const target = this.target

    const audio = combineChunks(this.chunks)
    this.chunks = []
    const wav = encodePcm16Wav(audio, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const form = new FormData()
    form.append('model', target.apiModel)
    form.append('response_format', 'json')
    if (target.language) {
      form.append('language', target.language)
    }
    // Why: OpenAI's transcription endpoint expects a multipart file object;
    // a named WAV blob avoids filesystem temp files and works in packaged apps.
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav')

    const apiKey = target.readApiKey()
    // Why: a user-selected LAN/remote server can leave the request open; without a
    // deadline the cloud stop path would wait forever instead of releasing the
    // session and reporting a failure.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TRANSCRIPTION_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetch(target.url, {
        method: 'POST',
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        body: form,
        signal: controller.signal
      })
    } catch (error) {
      throw error instanceof Error && error.name === 'AbortError'
        ? new Error(`Transcription timed out after ${TRANSCRIPTION_TIMEOUT_MS / 1000}s`)
        : error
    } finally {
      clearTimeout(timeout)
    }

    const data = (await response.json().catch(() => ({}))) as OpenAiTranscriptionResponse
    if (!response.ok) {
      const message =
        typeof data.error?.message === 'string'
          ? sanitizeOpenAiTranscriptionErrorMessage(data.error.message)
          : response.statusText
      throw new Error(`Transcription failed: ${message}`)
    }

    return parseOpenAiTranscriptionResponse(data)
  }
}
