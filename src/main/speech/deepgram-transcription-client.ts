import { resampleToRate } from './stt-audio-resample'

export const DEEPGRAM_TRANSCRIPTION_MODEL_BY_ID: Record<string, string> = {
  'deepgram-nova-3': 'nova-3'
}

const DEEPGRAM_TRANSCRIPTION_ENDPOINT = 'https://api.deepgram.com/v1/listen'
const CLOUD_TRANSCRIPTION_SAMPLE_RATE = 16_000
const MAX_CLOUD_AUDIO_SECONDS = 10 * 60
const DEEPGRAM_TRANSCRIPTION_REQUEST_TIMEOUT_MS = 60_000
const MAX_DEEPGRAM_TRANSCRIPTION_RESPONSE_BYTES = 1_000_000
const DEEPGRAM_TRANSCRIPTION_TIMEOUT_MESSAGE = 'Deepgram transcription request timed out'

type DeepgramTranscriptionResponse = {
  err_msg?: unknown
  results?: {
    channels?: {
      alternatives?: {
        transcript?: unknown
      }[]
    }[]
  }
}

function buildDeepgramTranscriptionUrl(apiModel: string): string {
  const url = new URL(DEEPGRAM_TRANSCRIPTION_ENDPOINT)
  url.searchParams.set('model', apiModel)
  url.searchParams.set('language', 'ko')
  url.searchParams.set('smart_format', 'true')
  return url.toString()
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

function parseDeepgramTranscriptionResponse(data: DeepgramTranscriptionResponse): string {
  const transcript = data.results?.channels?.[0]?.alternatives?.[0]?.transcript
  if (typeof transcript === 'string') {
    return transcript.trim()
  }
  if (typeof data.err_msg === 'string') {
    throw new Error('Deepgram transcription failed')
  }
  throw new Error('Deepgram transcription response did not include text')
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    return Promise.reject(new Error(DEEPGRAM_TRANSCRIPTION_TIMEOUT_MESSAGE))
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel()
      reject(new Error(DEEPGRAM_TRANSCRIPTION_TIMEOUT_MESSAGE))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function readBoundedDeepgramResponse(
  response: Response,
  signal: AbortSignal
): Promise<DeepgramTranscriptionResponse> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_DEEPGRAM_TRANSCRIPTION_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response)
    throw new Error('Deepgram transcription response was too large')
  }

  const reader = response.body?.getReader()
  if (!reader) {
    return {}
  }

  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const { done, value } = await readChunkWithAbort(reader, signal)
      if (done) {
        break
      }
      byteLength += value.byteLength
      if (byteLength > MAX_DEEPGRAM_TRANSCRIPTION_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Deepgram transcription response was too large')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === 'Deepgram transcription response was too large' ||
        error.message === DEEPGRAM_TRANSCRIPTION_TIMEOUT_MESSAGE)
    ) {
      throw error
    }
    throw new Error('Deepgram transcription response could not be read')
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // A timed-out read can still be settling; cancellation above releases the stream shortly.
    }
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as DeepgramTranscriptionResponse
  } catch {
    return {}
  }
}

export class DeepgramTranscriptionSession {
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

    const apiModel = DEEPGRAM_TRANSCRIPTION_MODEL_BY_ID[this.modelId]
    if (!apiModel) {
      throw new Error(`Unknown Deepgram transcription model: ${this.modelId}`)
    }

    const audio = combineChunks(this.chunks)
    this.chunks = []
    const wav = encodePcm16Wav(audio, CLOUD_TRANSCRIPTION_SAMPLE_RATE)
    const abortController = new AbortController()
    const timeout = setTimeout(
      () => abortController.abort(),
      DEEPGRAM_TRANSCRIPTION_REQUEST_TIMEOUT_MS
    )
    let response: Response
    try {
      response = await fetch(buildDeepgramTranscriptionUrl(apiModel), {
        method: 'POST',
        headers: {
          Authorization: `Token ${this.readApiKey()}`,
          'Content-Type': 'audio/wav'
        },
        body: new Uint8Array(wav),
        signal: abortController.signal
      })
    } catch {
      clearTimeout(timeout)
      if (abortController.signal.aborted) {
        throw new Error(DEEPGRAM_TRANSCRIPTION_TIMEOUT_MESSAGE)
      }
      throw new Error('Deepgram transcription request failed')
    }

    try {
      if (!response.ok) {
        await cancelResponseBody(response)
        throw new Error('Deepgram transcription failed')
      }

      const data = await readBoundedDeepgramResponse(response, abortController.signal)
      return parseDeepgramTranscriptionResponse(data)
    } finally {
      clearTimeout(timeout)
    }
  }
}
