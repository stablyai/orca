import { resampleToRate } from './stt-audio-resample'
import { readFetchResponseJsonWithinLimit } from '../lib/fetch-response-body'

export const OPENAI_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'openai-gpt-4o-mini-transcribe': 'gpt-4o-mini-transcribe',
  'openai-gpt-4o-transcribe': 'gpt-4o-transcribe'
}

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions'
const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16000
const MAX_CLOUD_AUDIO_SECONDS = 10 * 60
const MAX_CLOUD_AUDIO_SAMPLES = CLOUD_TRANSCRIPTION_SAMPLE_RATE * MAX_CLOUD_AUDIO_SECONDS

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

function encodePcm16Wav(samples: Float32Array, sampleCount: number, sampleRate: number): Buffer {
  const dataBytes = sampleCount * 2
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

  for (let i = 0; i < sampleCount; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    const value = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
    buffer.writeInt16LE(Math.round(value), 44 + i * 2)
  }

  return buffer
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
  private samples = new Float32Array(0)
  private sampleCount = 0

  constructor(
    private readonly modelId: string,
    private readonly readApiKey: () => string
  ) {}

  feedAudio(samples: Float32Array, sampleRate: number): void {
    const normalized = resampleToRate(samples, sampleRate, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const nextSampleCount = this.sampleCount + normalized.length
    if (nextSampleCount > MAX_CLOUD_AUDIO_SAMPLES) {
      throw new Error('Cloud transcription is limited to 10 minutes per dictation')
    }
    if (this.samples.length < nextSampleCount) {
      const nextCapacity = Math.min(
        MAX_CLOUD_AUDIO_SAMPLES,
        Math.max(CLOUD_TRANSCRIPTION_SAMPLE_RATE, this.samples.length * 2, nextSampleCount)
      )
      const next = new Float32Array(nextCapacity)
      next.set(this.samples.subarray(0, this.sampleCount))
      this.samples = next
    }
    this.samples.set(normalized, this.sampleCount)
    this.sampleCount = nextSampleCount
  }

  async finish(): Promise<string> {
    if (this.sampleCount === 0) {
      return ''
    }

    const apiModel = OPENAI_TRANSCRIPTION_MODEL_BY_ID[this.modelId]
    if (!apiModel) {
      throw new Error(`Unknown OpenAI transcription model: ${this.modelId}`)
    }

    const wav = encodePcm16Wav(this.samples, this.sampleCount, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    this.samples = new Float32Array(0)
    this.sampleCount = 0
    const form = new FormData()
    form.append('model', apiModel)
    form.append('response_format', 'json')
    // Why: OpenAI's transcription endpoint expects a multipart file object;
    // a named WAV blob avoids filesystem temp files and works in packaged apps.
    form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'dictation.wav')

    const response = await fetch(OPENAI_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.readApiKey()}`
      },
      body: form
    })

    const data = await readFetchResponseJsonWithinLimit<OpenAiTranscriptionResponse>(
      response
    ).catch((): OpenAiTranscriptionResponse => ({}))
    if (!response.ok) {
      const message =
        typeof data.error?.message === 'string'
          ? sanitizeOpenAiTranscriptionErrorMessage(data.error.message)
          : response.statusText
      throw new Error(`OpenAI transcription failed: ${message}`)
    }

    return parseOpenAiTranscriptionResponse(data)
  }
}
