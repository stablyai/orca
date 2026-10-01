import type { CustomSttEndpointReachability } from '../../shared/speech-types'

export type CustomSttModelDiscoveryResult = {
  ok: boolean
  models: string[]
  reachability: CustomSttEndpointReachability
  /** Where the list came from, for diagnostics. */
  source?: 'openai-models' | 'health' | 'models'
  detail?: string
}

const DISCOVERY_TIMEOUT_MS = 6_000
const MAX_MODELS = 200

export type CustomSttModelDiscoveryInput = {
  baseUrl: string
  apiKey?: string | null
}

/**
 * Best-effort discovery of the models an OpenAI-compatible endpoint accepts.
 *
 * There is no single standard: OpenAI itself exposes `GET /v1/models`
 * (`{ data: [{ id }] }`), while leaner self-hosted servers often only expose a
 * health document with a `supportedModels` array. Try the standard first, then
 * the common fallbacks, and return an empty list rather than failing — the model
 * field stays free text, so a miss only costs the suggestions.
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

  // Why: a base URL may already name the transcription path or the version segment;
  // derive a root so `/v1/models`, `/health` and `/models` all resolve.
  const root = base.replace(/\/audio\/transcriptions$/i, '').replace(/\/v1$/i, '')

  const candidates: { url: string; source: CustomSttModelDiscoveryResult['source'] }[] = [
    { url: `${root}/v1/models`, source: 'openai-models' },
    { url: `${root}/health`, source: 'health' },
    { url: `${root}/models`, source: 'models' }
  ]

  let sawResponse = false
  for (const candidate of candidates) {
    const probe = await tryFetchModels(candidate.url, input.apiKey ?? null)
    if (probe.responded) {
      // Why: any HTTP response — including 401/403 — proves the endpoint is there.
      // A token-protected server is "reachable, needs a key", not "broken".
      sawResponse = true
    }
    if (probe.models && probe.models.length > 0) {
      return {
        ok: true,
        models: probe.models,
        reachability: 'reachable',
        source: candidate.source
      }
    }
  }

  return {
    ok: false,
    models: [],
    reachability: sawResponse ? 'reachable' : 'unreachable',
    detail: sawResponse
      ? 'Endpoint reachable, but it did not advertise a model list.'
      : 'No model list found on this endpoint.'
  }
}

async function tryFetchModels(
  url: string,
  apiKey: string | null
): Promise<{ responded: boolean; models: string[] | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: controller.signal
    })
    const data = (await response.json().catch(() => null)) as unknown
    return { responded: true, models: response.ok ? extractModelIds(data) : null }
  } catch {
    return { responded: false, models: null }
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
