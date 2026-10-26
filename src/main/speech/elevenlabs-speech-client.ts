import type { ElevenLabsSpeechRequest, ElevenLabsVoice } from '../../shared/speech-types'
import { readElevenLabsSpeechApiKey } from './elevenlabs-api-key-store'

const API = 'https://api.elevenlabs.io'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

export function validateElevenLabsSpeechRequest(value: unknown): ElevenLabsSpeechRequest {
  if (
    !value ||
    typeof value !== 'object' ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(value.requestId) ||
    !('text' in value) ||
    typeof value.text !== 'string' ||
    !value.text.trim() ||
    value.text.length > 500 ||
    !('voiceId' in value) ||
    typeof value.voiceId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(value.voiceId) ||
    !('modelId' in value) ||
    (value.modelId !== 'eleven_flash_v2_5' && value.modelId !== 'eleven_multilingual_v2')
  ) {
    throw new Error('elevenlabs_invalid_request')
  }
  return {
    requestId: value.requestId,
    text: value.text,
    voiceId: value.voiceId,
    modelId: value.modelId
  }
}

async function request(path: string, options: RequestInit, signal: AbortSignal): Promise<Response> {
  try {
    const response = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'xi-api-key': readElevenLabsSpeechApiKey() },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
    })
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error(`elevenlabs_http_${response.status}`)
    }
    return response
  } catch (error) {
    if (error instanceof Error && /^elevenlabs_(http_\d{3}|key_unavailable)$/.test(error.message)) {
      throw error
    }
    throw new Error(signal.aborted ? 'elevenlabs_canceled' : 'elevenlabs_connection_failed')
  }
}

async function readBody(
  response: Response,
  onChunk?: (chunk: Uint8Array) => void
): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('elevenlabs_empty_response')
  }
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        throw new Error('elevenlabs_response_too_large')
      }
      if (onChunk) {
        onChunk(value)
      } else {
        chunks.push(value)
      }
    }
    if (!size) {
      throw new Error('elevenlabs_empty_response')
    }
    return Buffer.concat(chunks)
  } catch {
    await reader.cancel().catch(() => undefined)
    throw new Error('elevenlabs_response_failed')
  } finally {
    reader.releaseLock()
  }
}

export async function listElevenLabsVoices(signal: AbortSignal): Promise<ElevenLabsVoice[]> {
  const response = await request('/v2/voices?page_size=100&sort=name', {}, signal)
  let data: unknown
  try {
    data = JSON.parse((await readBody(response)).toString('utf8'))
  } catch {
    throw new Error('elevenlabs_response_failed')
  }
  if (!data || typeof data !== 'object' || !('voices' in data) || !Array.isArray(data.voices)) {
    throw new Error('elevenlabs_invalid_response')
  }
  return data.voices.flatMap((voice: unknown) => {
    if (
      voice &&
      typeof voice === 'object' &&
      'voice_id' in voice &&
      typeof voice.voice_id === 'string' &&
      /^[a-zA-Z0-9_-]{1,100}$/.test(voice.voice_id) &&
      'name' in voice &&
      typeof voice.name === 'string'
    ) {
      return [{ id: voice.voice_id, name: voice.name.slice(0, 120) }]
    }
    return []
  })
}

export async function synthesizeElevenLabsSpeech(
  input: ElevenLabsSpeechRequest,
  signal: AbortSignal,
  onChunk?: (chunk: Uint8Array) => void
): Promise<Uint8Array> {
  const format = onChunk ? 'pcm_24000' : 'mp3_44100_128'
  const response = await request(
    `/v1/text-to-speech/${encodeURIComponent(input.voiceId)}/stream?output_format=${format}`,
    {
      method: 'POST',
      body: JSON.stringify({
        text: input.text,
        model_id: input.modelId,
        voice_settings: {
          stability: 0.7,
          similarity_boost: 0.75,
          style: 0,
          speed: 0.95,
          use_speaker_boost: true
        }
      })
    },
    signal
  )
  return new Uint8Array(await readBody(response, onChunk))
}
