import { getMainHttpClient } from '../network/http-client'
import { resampleToRate } from './stt-audio-resample'
import type { CloudTranscriptionTarget } from './cloud-transcription-target'
import {
  CLOUD_TRANSCRIPTION_SAMPLE_RATE,
  MAX_CLOUD_TRANSCRIPTION_SECONDS,
  cloudTranscriptionTimeoutMs
} from '../../shared/dictation-finish-deadlines'

const MAX_CLOUD_AUDIO_SAMPLES = MAX_CLOUD_TRANSCRIPTION_SECONDS * CLOUD_TRANSCRIPTION_SAMPLE_RATE

export type OpenAiTranscriptionResponse = {
  text?: unknown
  error?: {
    message?: unknown
  }
}

export function sanitizeOpenAiTranscriptionErrorMessage(message: string, apiKey = ''): string {
  if (/incorrect api key provided:/i.test(message)) {
    return 'Incorrect OpenAI API key provided.'
  }

  // Other providers' keys have other shapes, so also redact the exact key sent (unless it's a placeholder like "x").
  const sanitized = (apiKey.length >= 8 ? message.split(apiKey).join('[redacted]') : message)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .trim()

  return sanitized || 'Transcription request failed'
}

function writePcm16Samples(view: DataView, samples: Float32Array, offset: number): void {
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    view.setInt16(offset + i * 2, Math.round(value), true)
  }
}

function encodePcm16Wav(chunks: Float32Array[], sampleRate: number): Buffer<ArrayBuffer> {
  const dataBytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0) * 2
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

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = 44
  for (const samples of chunks) {
    writePcm16Samples(view, samples, offset)
    offset += samples.length * 2
  }

  return buffer
}

/** The one request both transcription and the key check send; the main HTTP client follows the app's proxy. */
export function postOpenAiTranscription(
  url: string,
  apiKey: string,
  form: FormData,
  signal: AbortSignal
): Promise<Response> {
  return getMainHttpClient().fetch(url, {
    method: 'POST',
    // Bearer auth only: keep the provider's cookies out of the shared desktop session.
    credentials: 'omit',
    signal,
    // Local servers that take no key get no Authorization header.
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: form
  })
}

export function readOpenAiErrorMessage(
  data: OpenAiTranscriptionResponse,
  apiKey = ''
): string | undefined {
  return typeof data.error?.message === 'string'
    ? sanitizeOpenAiTranscriptionErrorMessage(data.error.message, apiKey)
    : undefined
}

// gpt-transcribe takes a list of expected languages in place of the singular field others use.
function languageField(model: string): string {
  return /^gpt-(live-)?transcribe/.test(model) ? 'languages[]' : 'language'
}

export class OpenAiTranscriptionSession {
  private chunks: Float32Array[] = []
  private audioSamples = 0
  private readonly abortController = new AbortController()

  constructor(
    private readonly readTarget: () => CloudTranscriptionTarget,
    private readonly language?: string
  ) {}

  cancel(): void {
    this.chunks = []
    this.audioSamples = 0
    this.abortController.abort()
  }

  /** Keeps audio up to the 10-minute upload cap; returns true on the chunk that reaches it. */
  feedAudio(samples: Float32Array, sampleRate: number): boolean {
    const room = MAX_CLOUD_AUDIO_SAMPLES - this.audioSamples
    if (this.abortController.signal.aborted || room <= 0) {
      return false
    }
    const normalized = resampleToRate(samples, sampleRate, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const kept = normalized.slice(0, room)
    this.audioSamples += kept.length
    this.chunks.push(kept)
    return this.audioSamples === MAX_CLOUD_AUDIO_SAMPLES
  }

  async finish(): Promise<string> {
    if (this.chunks.length === 0) {
      return ''
    }

    const target = this.readTarget()
    const chunks = this.chunks
    this.chunks = []
    const wav = encodePcm16Wav(chunks, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    // No response_format: JSON is the default everywhere, and not every provider accepts the field.
    const form = new FormData()
    form.append('model', target.model)
    if (this.language) {
      form.append(languageField(target.model), this.language)
    }
    // A named WAV blob satisfies multipart uploads without temporary files.
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'dictation.wav')

    const timeout = AbortSignal.timeout(cloudTranscriptionTimeoutMs(this.audioSamples))
    try {
      return await upload(target, form, AbortSignal.any([this.abortController.signal, timeout]))
    } catch (error) {
      if (timeout.aborted && !this.abortController.signal.aborted) {
        throw new Error(
          `${target.label} transcription timed out. Check your connection and try again.`
        )
      }
      throw error
    }
  }
}

async function upload(
  target: CloudTranscriptionTarget,
  form: FormData,
  signal: AbortSignal
): Promise<string> {
  const response = await postOpenAiTranscription(target.url, target.apiKey, form, signal)
  const data = (await response.json().catch(() => ({}))) as OpenAiTranscriptionResponse
  const error = readOpenAiErrorMessage(data, target.apiKey)
  if (!response.ok) {
    throw new Error(`${target.label} transcription failed: ${error ?? response.statusText}`)
  }
  if (typeof data.text === 'string') {
    return data.text.trim()
  }
  throw new Error(error ?? `${target.label} transcription response did not include text`)
}
