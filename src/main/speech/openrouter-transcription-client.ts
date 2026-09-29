import {
  CloudTranscriptionAudio,
  type CloudTranscriptionSession
} from './cloud-transcription-audio'

export const OPENROUTER_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'openrouter-mai-transcribe-2': 'microsoft/mai-transcribe-2'
}

const OPENROUTER_TRANSCRIPTION_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'

export function sanitizeOpenRouterTranscriptionErrorMessage(message: string, apiKey = ''): string {
  if (/incorrect api key provided:/i.test(message)) {
    return 'Incorrect OpenRouter API key provided.'
  }
  const redacted = apiKey ? message.split(apiKey).join('[redacted]') : message
  return (
    redacted
      .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .trim() || 'OpenRouter transcription request failed'
  )
}

function getErrorMessage(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null || !('error' in data)) {
    return undefined
  }
  if (data.error === null || data.error === undefined) {
    return undefined
  }
  if (typeof data.error === 'string') {
    return data.error
  }
  if (
    typeof data.error === 'object' &&
    data.error !== null &&
    'message' in data.error &&
    typeof data.error.message === 'string'
  ) {
    return data.error.message
  }
  return 'OpenRouter returned a transcription error'
}

export class OpenRouterTranscriptionSession implements CloudTranscriptionSession {
  private readonly audio = new CloudTranscriptionAudio()

  constructor(
    private readonly modelId: string,
    private readonly readApiKey: () => string
  ) {}

  feedAudio(samples: Float32Array, sampleRate: number): void {
    this.audio.feedAudio(samples, sampleRate)
  }

  async finish(): Promise<string> {
    const wav = this.audio.takeWav()
    if (!wav) {
      return ''
    }
    const model = OPENROUTER_TRANSCRIPTION_MODEL_BY_ID[this.modelId]
    if (!model) {
      throw new Error(`Unknown OpenRouter transcription model: ${this.modelId}`)
    }

    const apiKey = this.readApiKey()
    try {
      const audioData = wav.toString('base64')
      // Allow upload time for the base64 payload as well as provider processing.
      const timeoutMs = 60_000 + Math.ceil(audioData.length / 1_000_000) * 10_000
      // OpenRouter's STT API accepts base64 audio in JSON, separate from chat completions.
      const response = await fetch(OPENROUTER_TRANSCRIPTION_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://onorca.dev',
          'X-OpenRouter-Title': 'Orca'
        },
        body: JSON.stringify({
          model,
          input_audio: { data: audioData, format: 'wav' }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      const data: unknown = await response.json().catch(() => null)
      const errorMessage = getErrorMessage(data)
      if (!response.ok || errorMessage !== undefined) {
        const message =
          errorMessage ||
          (response.status === 401 || response.status === 403
            ? 'Check your OpenRouter API key'
            : response.statusText || `HTTP ${response.status}`)
        throw new Error(`OpenRouter transcription failed: ${message}`)
      }
      if (
        typeof data === 'object' &&
        data !== null &&
        'text' in data &&
        typeof data.text === 'string'
      ) {
        return data.text.trim()
      }
      throw new Error('OpenRouter transcription response did not include text')
    } catch (error) {
      throw new Error(
        sanitizeOpenRouterTranscriptionErrorMessage(
          error instanceof Error ? error.message : String(error),
          apiKey
        )
      )
    }
  }
}
