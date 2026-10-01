import {
  readCustomSttEndpointApiKey,
  readCustomSttEndpointConfig,
  resolveCustomSttTranscriptionUrl
} from './custom-stt-endpoint-store'

import type { CustomSttEndpointTestOutcome } from '../../shared/speech-types'

export type CustomSttEndpointTestResult = {
  ok: boolean
  outcome: CustomSttEndpointTestOutcome
  /** A short, secret-free description of what happened. */
  detail: string
}

const TEST_TIMEOUT_MS = 10_000
const MAX_ERROR_BODY_CHARS = 300

/** Inline values from the settings dialog, so Test reflects what is on screen. */
export type CustomSttEndpointProbe = {
  baseUrl: string
  model: string
  language: string
}

/**
 * Probe the endpoint with a tiny silent WAV. The goal is a fast reachability/auth
 * check for the settings UI — a 400/422 decode rejection still proves the URL
 * resolved and the server answered, so only transport failures and 401/403 are
 * treated as errors.
 *
 * `probe` carries the dialog's current draft; when omitted the saved config is used.
 */
export async function testCustomSttEndpoint(
  probe?: CustomSttEndpointProbe
): Promise<CustomSttEndpointTestResult> {
  const saved = readCustomSttEndpointConfig()
  const baseUrl = probe?.baseUrl?.trim() || saved?.baseUrl
  const model = probe?.model?.trim() || saved?.model || ''
  const language = (probe?.language ?? saved?.language ?? '').trim()

  if (!baseUrl) {
    return { ok: false, outcome: 'invalid', detail: 'Enter a base URL first.' }
  }
  // Why: a model is not required to prove reachability — the user can Test right
  // after pasting a URL, then pick a model from the discovered list. Send no
  // `model` field at all in that case (most servers fall back to a default),
  // rather than a placeholder name a strict server would reject.

  // Why: a bad base URL is the most common mistake; reject it here rather than
  // sending the user through a generic transport failure.
  try {
    const parsed = new URL(baseUrl)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        outcome: 'invalid',
        detail: 'Base URL must start with http:// or https://.'
      }
    }
  } catch {
    return { ok: false, outcome: 'invalid', detail: 'Base URL is not a valid URL.' }
  }

  const url = resolveCustomSttTranscriptionUrl(baseUrl)
  const apiKey = readCustomSttEndpointApiKey()

  // Why: undici reuses keep-alive connections, and servers like uvicorn close idle
  // ones — a reused dead socket fails the POST with a bare "fetch failed". GET
  // requests are auto-retried by undici but POST is not, so retry once ourselves.
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
    try {
      const response = await postProbe(url, model, language, apiKey, controller.signal)
      if (response.ok) {
        return { ok: true, outcome: 'ok', detail: `Reachable (HTTP ${response.status}).` }
      }
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          outcome: 'auth',
          detail: `Authentication failed (HTTP ${response.status}).`
        }
      }
      // Why: a non-auth error status means the server answered and refused the
      // request. Servers are inconsistent about the class — a bad language is 400
      // on some and 500 on others — so treat any 4xx, or a 5xx that explains
      // itself with a body, as a deterministic rejection (blocking Save). A bare
      // 5xx with no body is more likely transient, so leave it as transport.
      const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS)
      const rejected = response.status < 500 || body.length > 0
      return {
        ok: false,
        outcome: rejected ? 'rejected' : 'transport',
        detail: `${rejected ? 'Server rejected the request' : 'Server error'} (HTTP ${
          response.status
        })${body ? `: ${body}` : ''}`
      }
    } catch (error) {
      lastError = error
    } finally {
      clearTimeout(timeout)
    }
  }

  return {
    ok: false,
    outcome: 'transport',
    detail: `Could not reach endpoint: ${describeFetchError(lastError)}`
  }
}

function postProbe(
  url: string,
  model: string,
  language: string,
  apiKey: string | null,
  signal: AbortSignal
): Promise<Response> {
  const form = new FormData()
  if (model) {
    form.append('model', model)
  }
  form.append('response_format', 'json')
  if (language) {
    form.append('language', language)
  }
  form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'test.wav')
  return fetch(url, {
    method: 'POST',
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    body: form,
    signal
  })
}

/**
 * `fetch` collapses every transport failure into "fetch failed"; the actionable
 * cause (ECONNREFUSED, certificate error, DNS) lives on `error.cause`. Surface one
 * level of cause so the settings UI says something a user can act on.
 */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  if (error.name === 'AbortError') {
    return `timed out after ${TEST_TIMEOUT_MS / 1000}s`
  }
  const cause = (error as { cause?: unknown }).cause
  const causeMessage =
    cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : undefined
  return causeMessage && causeMessage !== error.message
    ? `${error.message} (${causeMessage})`
    : error.message
}

/** 16-bit PCM WAV of ~0.1s of silence, enough for a server to accept or reject. */
function silentWav(): Uint8Array<ArrayBuffer> {
  const sampleRate = 16000
  const samples = 1600
  const dataBytes = samples * 2
  const bytes = new Uint8Array(44 + dataBytes)
  const view = new DataView(bytes.buffer)
  const writeAscii = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i))
    }
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeAscii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return bytes
}
