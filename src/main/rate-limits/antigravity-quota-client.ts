import { net } from 'electron'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import { ANTIGRAVITY_USER_AGENT } from './antigravity-oauth-sources'
import { deriveSessionSummary } from './gemini-bucket-formatting'

const API_TIMEOUT_MS = 10_000
// Why: retrieveUserQuota 403s (SUBSCRIPTION_REQUIRED) even for valid
// Antigravity tokens — the current contract is fetchAvailableModels, whose
// response carries per-model quotaInfo alongside capability metadata (the
// same endpoint the agy CLI and sub2api use).
const FETCH_MODELS_URL = 'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels'

type ModelQuotaInfo = { remainingFraction?: number; resetTime?: string }
type ModelEntry = { quotaInfo?: ModelQuotaInfo; displayName?: string }

function isModelEntry(o: unknown): o is ModelEntry {
  return typeof o === 'object' && o !== null
}

function parseModelsResponse(data: unknown): Record<string, ModelEntry> {
  if (!data || typeof data !== 'object' || 'models' in data === false) {
    return {}
  }
  const models = (data as { models?: unknown }).models
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(models).filter(([, v]) => isModelEntry(v)) as [string, ModelEntry][]
  )
}

function buildModelBuckets(models: Record<string, ModelEntry>): RateLimitBucket[] {
  const buckets: RateLimitBucket[] = []
  for (const [modelId, entry] of Object.entries(models)) {
    const quota = entry.quotaInfo
    // Why: models without a numeric remainingFraction are unlimited for this
    // tier (or not quota-tracked); rendering them as 0% used would be noise.
    if (
      !quota ||
      typeof quota.remainingFraction !== 'number' ||
      !Number.isFinite(quota.remainingFraction)
    ) {
      continue
    }
    const resetsAtMs = quota.resetTime ? Date.parse(quota.resetTime) : Number.NaN
    buckets.push({
      name: entry.displayName?.trim() || modelId,
      usedPercent: Math.min(100, Math.max(0, Math.round((1 - quota.remainingFraction) * 100))),
      windowMinutes: 300,
      resetsAt: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
      resetDescription: null
    })
  }
  // Why: unlike the gemini-cli retrieveUserQuota feed (where several model ids
  // share one underlying bucket), fetchAvailableModels returns one row per
  // model — distinct models with coincidentally equal usage must all render,
  // so they are sorted by name instead of deduplicated.
  buckets.sort((a, b) => a.name.localeCompare(b.name))
  return buckets
}

/** Queries v1internal:fetchAvailableModels for one credential + project and
 *  maps the per-model quotaInfo into rate-limit buckets. */
export async function fetchAntigravityQuota(
  accessToken: string,
  projectId: string
): Promise<ProviderRateLimits> {
  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, API_TIMEOUT_MS)
  try {
    const fetchFn = net?.fetch ?? fetch
    const res = await fetchFn(FETCH_MODELS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'User-Agent': ANTIGRAVITY_USER_AGENT
      },
      body: JSON.stringify({ project: projectId }),
      signal: controller.signal
    })
    if (!res.ok) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: `Quota fetch failed (${res.status})`,
        status: 'error'
      }
    }
    const data = (await res.json()) as unknown
    const buckets = buildModelBuckets(parseModelsResponse(data))
    // Why: the session card should summarize the tightest *timed* window;
    // internal models can carry quota without a reset timestamp.
    const timedBuckets = buckets.filter((b) => b.resetsAt !== null)
    return {
      provider: 'antigravity',
      session: deriveSessionSummary(timedBuckets.length > 0 ? timedBuckets : buckets),
      weekly: null,
      buckets,
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } finally {
    clearTimeout(timeout)
  }
}
