import { net } from 'electron'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import {
  readGeminiCredentials,
  tryRefreshTokenFromBundle,
  type GeminiCredentials
} from './gemini-oauth-sources'
import { readAntigravityKeyringCredentials } from './antigravity-keyring'
import { buildRateLimitBucket, deriveSessionSummary } from './gemini-bucket-formatting'

// Why: Antigravity (Google's agentic coding tool, CLI `agy`) authenticates the
// same Google account the Gemini CLI uses and shares the `~/.gemini` config
// directory. Its subscription usage is served by Google's Code Assist backend
// on the same host as Gemini's, but under the ANTIGRAVITY ideType, which
// returns Antigravity's own per-model quota rather than the Gemini CLI quota.
// Phase 1 is single-account and READ-ONLY. It sources the Google OAuth token
// from, in order: (1) `~/.gemini/oauth_creds.json` (written by a Gemini CLI
// login), then (2) the OS credential store where the `agy` CLI keeps its token
// (Windows Credential Manager entry `gemini:antigravity`, macOS/Linux keyring).
// It never rewrites either source, so it can't race the Gemini provider or the
// `agy` CLI that own them.
const API_TIMEOUT_MS = 10_000
// Nominal session window (5h) shown on the status-bar segment label, matching
// the other subscription providers; the exact per-model reset is in the popover.
const SESSION_WINDOW_MINUTES = 300
// Internal autocomplete/chat quota buckets that are not user-facing models.
const INTERNAL_MODEL_RE = /^(tab_|chat_)/
const BASE_URL = 'https://cloudcode-pa.googleapis.com'
const LOAD_CODE_ASSIST_URL = `${BASE_URL}/v1internal:loadCodeAssist`
const FETCH_AVAILABLE_MODELS_URL = `${BASE_URL}/v1internal:fetchAvailableModels`
const RETRIEVE_QUOTA_URL = `${BASE_URL}/v1internal:retrieveUserQuota`

// Why: mirrors CodexBar's AntigravityRemoteUsageFetcher metadata so the backend
// returns Antigravity quota buckets, not the Gemini CLI's.
const ANTIGRAVITY_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: 'PLATFORM_UNSPECIFIED',
  pluginType: 'GEMINI'
} as const

type ModelQuota = { remainingFraction: number; resetTime: string; modelId: string }

// Why: the Antigravity app groups usage into two model families; we mirror those
// exact labels so the meter reads the same as the app's usage panel.
type AntigravityFamily = 'gemini' | 'claude-gpt'
const FAMILY_LABEL: Record<AntigravityFamily, string> = {
  gemini: 'Gemini Models',
  'claude-gpt': 'Claude and GPT models'
}

/** Classify a model id into its Antigravity display family (Gemini vs Claude/GPT). */
function modelFamily(modelId: string): AntigravityFamily {
  return modelId.startsWith('gemini') ? 'gemini' : 'claude-gpt'
}

/** Build an `unavailable` result — the provider is not configured (no credentials). */
function unavailable(error: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable'
  }
}

/** Build an `error` result — a configured provider that failed transiently. */
function failed(error: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error'
  }
}

/** POST a JSON body to a Code Assist endpoint with the Antigravity Bearer auth headers. */
async function postJson(url: string, accessToken: string, body: unknown): Promise<Response> {
  return net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      // Why: the Antigravity backend keys quota off the calling client's
      // User-Agent; CodexBar sends "antigravity" and so do we.
      'User-Agent': 'antigravity'
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
}

/**
 * Extract the Code Assist project id from `cloudaicompanionProject`, which
 * comes back either as a bare string or a `{ value: string }` reference
 * depending on the account's onboarding state.
 */
function extractProjectId(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (value && typeof value === 'object' && 'value' in value) {
    const inner = (value as { value?: unknown }).value
    return typeof inner === 'string' ? inner.trim() : ''
  }
  return ''
}

/** Resolve the Code Assist project id via `loadCodeAssist` under the ANTIGRAVITY ideType. */
async function loadProjectId(accessToken: string): Promise<string> {
  const res = await postJson(LOAD_CODE_ASSIST_URL, accessToken, { metadata: ANTIGRAVITY_METADATA })
  if (!res.ok) {
    throw new Error(`loadCodeAssist failed (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { cloudaicompanionProject?: unknown }
  return extractProjectId(data.cloudaicompanionProject)
}

/** Type guard for a finite number (rejects NaN/Infinity and non-numbers). */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * Parse the primary usage source: `fetchAvailableModels` returns a
 * `{ models: { <id>: { quotaInfo: { remainingFraction, resetTime } } } }` map,
 * Antigravity's live per-model quota view. Skips entries without usable quota.
 */
function parseModelQuotas(data: unknown): ModelQuota[] {
  if (!data || typeof data !== 'object' || !('models' in data)) {
    return []
  }
  const models = (data as { models?: Record<string, unknown> }).models
  if (!models || typeof models !== 'object') {
    return []
  }
  const quotas: ModelQuota[] = []
  for (const [modelId, model] of Object.entries(models)) {
    if (!model || typeof model !== 'object' || !('quotaInfo' in model)) {
      continue
    }
    const quotaInfo = (model as { quotaInfo?: unknown }).quotaInfo
    if (!quotaInfo || typeof quotaInfo !== 'object') {
      continue
    }
    const { remainingFraction, resetTime } = quotaInfo as {
      remainingFraction?: unknown
      resetTime?: unknown
    }
    if (isFiniteNumber(remainingFraction) && typeof resetTime === 'string') {
      quotas.push({ remainingFraction, resetTime, modelId })
    }
  }
  return quotas
}

/** Parse the fallback usage source: `retrieveUserQuota` returns a `{ buckets: [...] }` array. */
function parseQuotaBuckets(data: unknown): ModelQuota[] {
  let rawBuckets: unknown[] = []
  if (data && typeof data === 'object' && 'buckets' in data && Array.isArray(data.buckets)) {
    rawBuckets = data.buckets
  }
  const quotas: ModelQuota[] = []
  for (const bucket of rawBuckets) {
    if (!bucket || typeof bucket !== 'object') {
      continue
    }
    const { remainingFraction, resetTime, modelId } = bucket as {
      remainingFraction?: unknown
      resetTime?: unknown
      modelId?: unknown
    }
    if (isFiniteNumber(remainingFraction) && typeof resetTime === 'string') {
      quotas.push({
        remainingFraction,
        resetTime,
        modelId: typeof modelId === 'string' ? modelId : 'unknown'
      })
    }
  }
  return quotas
}

/**
 * Fetch per-model quotas, preferring `fetchAvailableModels` and falling back to
 * `retrieveUserQuota` when the former is empty or errors. Throws
 * `UnauthorizedError` on 401 so the caller can refresh and retry once.
 */
async function fetchModelQuotas(accessToken: string, projectId: string): Promise<ModelQuota[]> {
  const body = projectId ? { project: projectId } : {}
  const modelsRes = await postJson(FETCH_AVAILABLE_MODELS_URL, accessToken, body)
  if (modelsRes.status === 401) {
    throw new UnauthorizedError()
  }
  if (modelsRes.ok) {
    const quotas = parseModelQuotas(await modelsRes.json())
    if (quotas.length > 0) {
      return quotas
    }
  }
  // Fall back to retrieveUserQuota when fetchAvailableModels is empty or errors.
  const quotaRes = await postJson(RETRIEVE_QUOTA_URL, accessToken, body)
  if (quotaRes.status === 401) {
    throw new UnauthorizedError()
  }
  if (!quotaRes.ok) {
    throw new Error(`Quota fetch failed (HTTP ${quotaRes.status})`)
  }
  return parseQuotaBuckets(await quotaRes.json())
}

/** Internal sentinel thrown on an HTTP 401 to trigger a single refresh + retry. */
class UnauthorizedError extends Error {
  constructor() {
    super('Antigravity request unauthorized (HTTP 401)')
    this.name = 'UnauthorizedError'
  }
}

/**
 * Map parsed model quotas into a `ProviderRateLimits`, deduplicating buckets and
 * summarizing the most-constrained one as the session window. Empty → `error`.
 */
function toRateLimits(quotas: ModelQuota[]): ProviderRateLimits {
  // Why: mirror how the Antigravity app itself presents usage — two model
  // families ("Gemini Models" and "Claude and GPT models"), each collapsed to a
  // single limit — instead of ~20 near-identical per-model rows. Each family
  // shows its most-constrained model (the binding limit). Internal
  // autocomplete/chat buckets (`tab_*`, `chat_*`) are dropped.
  const byFamily = new Map<AntigravityFamily, RateLimitBucket>()
  for (const quota of quotas) {
    if (INTERNAL_MODEL_RE.test(quota.modelId)) {
      continue
    }
    const family = modelFamily(quota.modelId)
    const bucket = buildRateLimitBucket(quota)
    const current = byFamily.get(family)
    // Keep the most-constrained (highest used) model as the family's limit.
    if (!current || bucket.usedPercent > current.usedPercent) {
      byFamily.set(family, { ...bucket, name: FAMILY_LABEL[family] })
    }
  }
  const buckets: RateLimitBucket[] = [...byFamily.values()].sort(
    (a, b) => b.usedPercent - a.usedPercent
  )
  if (buckets.length === 0) {
    return failed('Antigravity quota response did not include any model buckets')
  }
  const session = deriveSessionSummary(buckets)
  // Why: the per-model buckets use Gemini's nominal 1h window; the status-bar
  // segment renders the session with a "5h" label for parity with the other
  // subscription providers (the exact reset stays visible in the popover).
  if (session) {
    session.windowMinutes = SESSION_WINDOW_MINUTES
  }
  return {
    provider: 'antigravity',
    session,
    weekly: null,
    buckets,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

/**
 * Read the current Antigravity credentials from disk (Gemini CLI login) then the
 * OS keyring (agy). Used by the account store to seed / capture accounts.
 */
export async function readAntigravityCredentials(): Promise<GeminiCredentials | null> {
  try {
    return (await readGeminiCredentials()) ?? readAntigravityKeyringCredentials()
  } catch {
    return null
  }
}

/**
 * Return a usable access token: the stored one if unexpired, otherwise a fresh
 * one minted in memory via the Gemini CLI OAuth client. Never persisted — see
 * the inline note on why we don't rewrite the credential store.
 */
async function resolveAccessToken(creds: GeminiCredentials): Promise<string | null> {
  if (creds.expiry_date >= Date.now() && creds.access_token) {
    return creds.access_token
  }
  // Why: read-only refresh — reuse the Gemini CLI's OAuth client (same Google
  // account, same `~/.gemini` creds) to mint a fresh access token in memory.
  // We deliberately do NOT persist it: the Gemini provider owns that file, and
  // Google refresh tokens are reusable, so an in-memory token is sufficient.
  const refreshed = await tryRefreshTokenFromBundle(creds.refresh_token, true)
  return refreshed?.accessToken ?? null
}

/**
 * Read-only, single-account Antigravity subscription usage.
 *
 * Reads the Google OAuth token at `~/.gemini/oauth_creds.json` (written by a
 * Gemini/Google login on this host — the `agy` CLI keeps its own token in the
 * OS keyring, with no readable file), resolves the Code Assist project under
 * the ANTIGRAVITY ideType, and reports Antigravity's per-model quota. Never
 * writes the credentials file.
 *
 * @param credsOverride when provided (multi-account mode), fetch usage for that
 * specific account's stored credentials instead of the on-disk / keyring token.
 */
export async function fetchAntigravityRateLimits(
  credsOverride?: GeminiCredentials | null
): Promise<ProviderRateLimits> {
  let creds: GeminiCredentials | null
  try {
    // Prefer an explicit account's credentials; otherwise the file first
    // (Gemini CLI login), then the OS keyring where `agy` stores its token —
    // most Antigravity users only have the latter.
    creds = credsOverride ?? (await readGeminiCredentials()) ?? readAntigravityKeyringCredentials()
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'Unable to read Antigravity credentials')
  }
  if (!creds) {
    return unavailable(
      'Not signed in to Antigravity (no ~/.gemini credentials or agy keyring token)'
    )
  }

  try {
    const accessToken = await resolveAccessToken(creds)
    if (!accessToken) {
      return failed('Antigravity token expired — sign in again to refresh')
    }
    const projectId = await loadProjectId(accessToken).catch(() => '')
    try {
      return toRateLimits(await fetchModelQuotas(accessToken, projectId))
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        throw err
      }
      // One refresh + retry on 401, mirroring the Gemini fetcher.
      const refreshed = await tryRefreshTokenFromBundle(creds.refresh_token, true)
      if (!refreshed?.accessToken) {
        return failed('Antigravity request unauthorized and token refresh failed')
      }
      const retryProjectId = await loadProjectId(refreshed.accessToken).catch(() => projectId)
      return toRateLimits(await fetchModelQuotas(refreshed.accessToken, retryProjectId))
    }
  } catch (err) {
    return failed(err instanceof Error ? err.message : 'Antigravity usage request failed')
  }
}
