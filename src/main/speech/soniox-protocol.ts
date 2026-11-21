import WebSocket from 'ws'
import { z } from 'zod'
import { CLOUD_TRANSCRIPTION_SAMPLE_RATE } from '../../shared/speech/dictation/dictation-finish-deadlines'

export const SONIOX_REALTIME_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'
export const SONIOX_REALTIME_MODEL = 'stt-rt-v6'

// Without it a blackholed host never errors, and the dictation's audio piles up unsent.
const HANDSHAKE_TIMEOUT_MS = 10_000
// Transcript frames are small; the ws default (100 MiB) would let a bad endpoint exhaust memory.
const MAX_PAYLOAD_BYTES = 1024 * 1024

/** The part of a `ws` socket the stream uses, so tests can stand in for it. */
export type SonioxSocket = {
  readonly readyState: number
  readonly bufferedAmount: number
  send(data: string | Buffer): void
  close(code?: number): void
  terminate(): void
  on(event: string, listener: (...args: never[]) => void): unknown
  removeAllListeners(): unknown
}

export type OpenSonioxSocket = (url: string, apiKey: string) => SonioxSocket

export const openSonioxSocket: OpenSonioxSocket = (url, apiKey) =>
  new WebSocket(url, {
    handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    maxPayload: MAX_PAYLOAD_BYTES,
    headers: { Authorization: `Bearer ${apiKey}` }
  })

/** The stream's config frame; the key check sends the same one, so it tests the permission dictation needs. */
export function sonioxStreamConfig(
  language: string | undefined,
  terms: readonly string[] = []
): Record<string, unknown> {
  return {
    model: SONIOX_REALTIME_MODEL,
    audio_format: 'pcm_s16le',
    sample_rate: CLOUD_TRANSCRIPTION_SAMPLE_RATE,
    num_channels: 1,
    // An <end> token marks each pause, so text lands per phrase like the on-device models.
    enable_endpoint_detection: true,
    ...(language ? { language_hints: [language] } : {}),
    ...(terms.length > 0 ? { context: { terms } } : {})
  }
}

export const sonioxTokenFrameSchema = z.object({
  tokens: z.array(z.looseObject({ text: z.string(), is_final: z.boolean() })).optional(),
  finished: z.boolean().optional()
})

/** HTTP or error-frame statuses that mean Soniox refuses this key (402/403: billing or permissions on a valid key). */
export const SONIOX_REFUSED_KEY_STATUSES: ReadonlySet<number> = new Set([401, 402, 403])

/** Soniox's error frame, or null for a transcript frame. */
export function readSonioxError(frame: Record<string, unknown>): string | null {
  const code = frame.error_code
  const message = frame.error_message
  if (code === undefined && typeof message !== 'string') {
    return null
  }
  const status = typeof code === 'number' ? code : null
  const detail = typeof message === 'string' ? message : ''
  if (status !== null && SONIOX_REFUSED_KEY_STATUSES.has(status)) {
    return sonioxKeyRefusalMessage(status, detail)
  }
  return `Soniox error${status === null ? '' : ` ${status}`}: ${detail}`.trim()
}

/** The same words for a refused key whether Soniox says so at the handshake or in an error frame. */
export function sonioxKeyRefusalMessage(status: number, detail = ''): string {
  // 402/403 usually mean billing or permissions on a valid key, so they are worded apart from 401.
  const verdict = status === 401 ? 'rejected the API key' : 'refused this API key'
  return `Soniox ${verdict} (${status}). ${detail}`.trim()
}

export function parseSonioxFrame(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

/** Little-endian 16-bit PCM; typed arrays use the host's byte order, little-endian on every platform Orca ships. */
export function encodePcm16(samples: Float32Array): Buffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff)
  }
  return Buffer.from(pcm.buffer)
}
