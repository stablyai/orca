import {
  readCustomSttEndpointApiKey,
  readCustomSttEndpointConfig,
  resolveCustomSttTranscriptionUrl
} from './custom-stt-endpoint-store'

export type CustomSttEndpointTestResult = {
  ok: boolean
  /** A short, secret-free description of what happened. */
  detail: string
}

const TEST_TIMEOUT_MS = 10_000
const MAX_ERROR_BODY_CHARS = 300

/**
 * Probe the configured endpoint with a tiny silent WAV. The goal is a fast
 * reachability/auth check for the settings UI — a 400/422 decode rejection still
 * proves the URL resolved and the server answered, so only transport failures and
 * 401/403 are treated as errors.
 */
export async function testCustomSttEndpoint(): Promise<CustomSttEndpointTestResult> {
  const config = readCustomSttEndpointConfig()
  if (!config) {
    return { ok: false, detail: 'No custom endpoint is configured.' }
  }

  const url = resolveCustomSttTranscriptionUrl(config.baseUrl)
  const apiKey = readCustomSttEndpointApiKey()
  const form = new FormData()
  form.append('model', config.model)
  form.append('response_format', 'json')
  if (config.language) {
    form.append('language', config.language)
  }
  form.append('file', new Blob([silentWav()], { type: 'audio/wav' }), 'test.wav')

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: controller.signal
    })

    if (response.ok) {
      return { ok: true, detail: `Reachable (HTTP ${response.status}).` }
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, detail: `Authentication failed (HTTP ${response.status}).` }
    }
    // Any other status means the server is up and parsed the request shape.
    const body = (await response.text().catch(() => '')).slice(0, MAX_ERROR_BODY_CHARS)
    return {
      ok: true,
      detail: `Reachable (HTTP ${response.status})${body ? `: ${body}` : ''}`
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, detail: `Could not reach endpoint: ${reason}` }
  } finally {
    clearTimeout(timeout)
  }
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
