import type { CustomSttEndpointReachability } from '../../shared/speech-types'
import { resolveCustomSttTranscriptionUrl } from './custom-stt-endpoint-store'

export type CustomSttModelDiscoveryResult = {
  ok: boolean
  models: string[]
  reachability: CustomSttEndpointReachability
  /** Where the list came from, for diagnostics. */
  source?: 'openai-models' | 'health' | 'models'
  detail?: string
}

const DISCOVERY_TIMEOUT_MS = 6_000
const ROUTE_TIMEOUT_MS = 8_000
const MAX_MODELS = 200

export type CustomSttModelDiscoveryInput = {
  baseUrl: string
  apiKey?: string | null
}

/**
 * Probe an OpenAI-compatible endpoint: does it answer, and what models does it
 * advertise?
 *
 * Reachability is judged by the **actual transcription route**, not a health or
 * models endpoint. That distinction matters: a base URL missing its `/v1` segment
 * still answers `/health` with 200, so a health probe would show a green tick for
 * a URL whose `/audio/transcriptions` path is a 404. A `POST` with no audio file
 * to the resolved transcription URL is the cheapest reliable check — the route
 * exists if the server answers with anything other than 404.
 *
 * Model discovery is a separate best-effort GET: `GET /v1/models` (OpenAI),
 * then a health document's `supportedModels` (faster-whisper workers), then
 * `GET /models`. A miss only costs the suggestions.
 */
export async function discoverCustomSttModels(
  input: CustomSttModelDiscoveryInput
): Promise<CustomSttModelDiscoveryResult> {
  const base = normalizeBase(input.baseUrl)
  if (!base) {
    return {
      ok: false,
      models: [],
      reachability: 'unknown',
      detail: 'Enter a base URL first.'
    }
  }

  const apiKey = input.apiKey ?? null
  const reachability = await probeTranscriptionRoute(base, apiKey)
  const discovery = await findModelList(base, apiKey)

  return {
    ok: discovery.models.length > 0,
    models: discovery.models,
    reachability,
    ...(discovery.source ? { source: discovery.source } : {}),
    ...(discovery.detail ? { detail: discovery.detail } : {})
  }
}

/**
 * POST to the transcription URL with no audio. A 404 means the path does not
 * exist (wrong base URL); anything else — 200, 400, 401, 403, 405, 422 — proves
 * the route is there. A transport error means we never reached the server.
 */
async function probeTranscriptionRoute(
  baseUrl: string,
  apiKey: string | null
): Promise<CustomSttEndpointReachability> {
  const url = resolveCustomSttTranscriptionUrl(baseUrl)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS)
  try {
    const form = new FormData()
    form.append('response_format', 'json')
    const response = await fetch(url, {
      method: 'POST',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      body: form,
      signal: controller.signal
    })
    // Why: an unknown path is the one signal that the URL is wrong; every other
    // status (including auth rejections and missing-file errors) means the route
    // is served and the URL is usable.
    return response.status === 404 ? 'unreachable' : 'reachable'
  } catch {
    return 'unreachable'
  } finally {
    clearTimeout(timeout)
  }
}

async function findModelList(
  baseUrl: string,
  apiKey: string | null
): Promise<{
  models: string[]
  source?: CustomSttModelDiscoveryResult['source']
  detail?: string
}> {
  // A base URL may already name the transcription path or the version segment;
  // derive a root so `/v1/models`, `/health` and `/models` all resolve.
  const root = baseUrl.replace(/\/audio\/transcriptions$/i, '').replace(/\/v1$/i, '')
  const candidates: { url: string; source: CustomSttModelDiscoveryResult['source'] }[] = [
    { url: `${root}/v1/models`, source: 'openai-models' },
    { url: `${root}/health`, source: 'health' },
    { url: `${root}/models`, source: 'models' }
  ]

  for (const candidate of candidates) {
    const models = await tryFetchModels(candidate.url, apiKey)
    if (models && models.length > 0) {
      return { models, source: candidate.source }
    }
  }
  return { models: [], detail: 'No model list found on this endpoint.' }
}

async function tryFetchModels(url: string, apiKey: string | null): Promise<string[] | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    })
    if (!response.ok) {
      return null
    }
    const data = (await response.json().catch(() => null)) as unknown
    return extractModelIds(data)
  } catch {
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/** Accept the several shapes servers use for a model list. */
function extractModelIds(data: unknown): string[] | null {
  if (Array.isArray(data)) {
    return coerceModelList(data)
  }
  if (typeof data !== 'object' || data === null) {
    return null
  }
  const record = data as Record<string, unknown>
  if (Array.isArray(record.supportedModels)) {
    return coerceModelList(record.supportedModels)
  }
  if (Array.isArray(record.data)) {
    return coerceModelList(record.data)
  }
  if (Array.isArray(record.models)) {
    return coerceModelList(record.models)
  }
  return null
}

function coerceModelList(entries: unknown[]): string[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    if (typeof entry === 'string') {
      ids.add(entry)
    } else if (typeof entry === 'object' && entry !== null) {
      const id = (entry as Record<string, unknown>).id
      if (typeof id === 'string') {
        ids.add(id)
      }
    }
    if (ids.size >= MAX_MODELS) {
      break
    }
  }
  return [...ids]
}

function normalizeBase(value: string): string {
  return value.trim().replace(/\/+$/, '')
}
