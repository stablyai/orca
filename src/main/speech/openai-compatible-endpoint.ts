/**
 * Optional OpenAI-compatible transcription endpoint.
 *
 * Cloud dictation posts to api.openai.com through a hardcoded constant, so the
 * only way to use another OpenAI-compatible service (Groq, OpenRouter, a local
 * Whisper server) was to patch the packaged app. This module holds the reader
 * for the two voice settings that redirect it, set once by the speech runtime
 * service — the STT session itself has no store.
 */
import type { VoiceSettings } from '../../shared/speech-types'

export type OpenAiCompatibleEndpoint = {
  /** Full URL to POST the multipart form to. */
  url: string
  /** Model name to send, or null to keep the catalog model's OpenAI name. */
  model: string | null
}

const TRANSCRIPTION_PATH = '/v1/audio/transcriptions'

let readVoiceSettings: (() => VoiceSettings | null) | null = null

export function setVoiceSettingsReader(reader: (() => VoiceSettings | null) | null): void {
  readVoiceSettings = reader
}

/**
 * Appends the transcription path when the configured base URL has none, so
 * `http://127.0.0.1:8080` and `https://api.groq.com/openai/v1/audio/transcriptions`
 * both work. Returns null for anything that is not an absolute http(s) URL.
 */
export function resolveOpenAiCompatibleUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.trim()
  if (!trimmed) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return null
  }
  const path = parsed.pathname.replace(/\/+$/, '')
  return path ? `${parsed.origin}${path}${parsed.search}` : `${parsed.origin}${TRANSCRIPTION_PATH}`
}

/** The configured endpoint, or null when dictation should go to OpenAI. */
export function readOpenAiCompatibleEndpoint(): OpenAiCompatibleEndpoint | null {
  const settings = readVoiceSettings?.()?.openAiCompatible ?? null
  const url = settings ? resolveOpenAiCompatibleUrl(settings.baseUrl) : null
  if (!url) {
    return null
  }
  const model = settings?.model.trim()
  return { url, model: model ? model : null }
}
