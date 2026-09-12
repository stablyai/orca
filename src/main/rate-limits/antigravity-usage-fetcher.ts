import { net } from 'electron'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_USER_AGENT,
  loadProjectId,
  readAuthJson,
  readAntigravityCredentials,
  readAntigravityKeychainCredentials,
  saveAntigravityCredentials,
  tryRefreshTokenFromBundle,
  type AntigravityCredentials,
  type GoogleAuthEntry
} from './antigravity-oauth-sources'
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

async function fetchQuota(accessToken: string, projectId: string): Promise<ProviderRateLimits> {
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

async function fetchViaAuthJson(
  auth: GoogleAuthEntry,
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = auth.access
  const refreshToken = (auth.refresh || '').split('|')[0] ?? ''
  if (auth.expires < Date.now() || !accessToken) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, antigravityCliOAuthEnabled)
    if (!refreshResult?.accessToken) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error: 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
  }
  let effectiveProjectId = ''
  try {
    effectiveProjectId = await loadProjectId(accessToken)
  } catch {
    effectiveProjectId =
      (auth.refresh || '').split('|')[1] || (auth.refresh || '').split('|')[2] || ''
  }
  if (!effectiveProjectId) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity project ID not found',
      status: 'error'
    }
  }
  const result = await fetchQuota(accessToken, effectiveProjectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(refreshToken, antigravityCliOAuthEnabled)
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return effectiveProjectId
      })
      return fetchQuota(refreshResult.accessToken, newProjectId)
    }
  }
  return result
}

async function fetchViaOauthCreds(
  creds: AntigravityCredentials,
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  let accessToken = creds.access_token
  let currentCreds = creds
  if (creds.expiry_date < Date.now()) {
    // Why: keychain tokens belong to the agy CLI's OAuth client; refreshing
    // them with the Gemini CLI bundle credentials would always fail. The CLI
    // refreshes the keychain entry itself, so surface a clear error instead.
    const refreshResult =
      creds.source === 'keychain'
        ? null
        : await tryRefreshTokenFromBundle(creds.refresh_token, antigravityCliOAuthEnabled)
    if (!refreshResult?.accessToken) {
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        updatedAt: Date.now(),
        error:
          creds.source === 'keychain'
            ? 'Antigravity token expired — run agy in your terminal to refresh it, then retry'
            : 'Token refresh failed',
        status: 'error'
      }
    }
    accessToken = refreshResult.accessToken
    currentCreds = {
      ...creds,
      access_token: accessToken,
      expiry_date: refreshResult.expiresIn
        ? Date.now() + refreshResult.expiresIn * 1000
        : creds.expiry_date
    }
    await saveAntigravityCredentials(currentCreds)
  }
  const projectId = await loadProjectId(accessToken).catch(() => {
    return ''
  })
  if (!projectId) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity project ID not found',
      status: 'error'
    }
  }
  const result = await fetchQuota(accessToken, projectId)
  if (result.status === 'error' && result.error?.includes('401')) {
    const refreshResult = await tryRefreshTokenFromBundle(
      currentCreds.refresh_token,
      antigravityCliOAuthEnabled
    )
    if (refreshResult?.accessToken) {
      const newProjectId = await loadProjectId(refreshResult.accessToken).catch(() => {
        return ''
      })
      if (newProjectId) {
        await saveAntigravityCredentials({
          ...currentCreds,
          access_token: refreshResult.accessToken,
          expiry_date: refreshResult.expiresIn
            ? Date.now() + refreshResult.expiresIn * 1000
            : currentCreds.expiry_date
        })
        return fetchQuota(refreshResult.accessToken, newProjectId)
      }
    }
  }
  return result
}

export async function fetchAntigravityRateLimits(
  antigravityCliOAuthEnabled = false
): Promise<ProviderRateLimits> {
  if (!antigravityCliOAuthEnabled) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: 'Antigravity CLI OAuth is disabled in settings',
      status: 'unavailable'
    }
  }

  try {
    // Why: prefer the freshest credential that actually works. The agy CLI's
    // keychain token is minted by the current Antigravity client; OpenCode's
    // auth.json and the legacy oauth_creds.json files carry Gemini-CLI-era
    // tokens that cloudcode-pa now rejects with 403.
    const keychainCreds = await readAntigravityKeychainCredentials()
    if (keychainCreds) {
      return await fetchViaOauthCreds(keychainCreds, antigravityCliOAuthEnabled)
    }
    const authJson = await readAuthJson()
    const result =
      authJson?.google?.type === 'oauth'
        ? await fetchViaAuthJson(authJson.google, antigravityCliOAuthEnabled)
        : await (async () => {
            const creds = await readAntigravityCredentials()
            return !creds
              ? ({
                  provider: 'antigravity',
                  session: null,
                  weekly: null,
                  updatedAt: Date.now(),
                  error: 'Antigravity CLI credentials not found',
                  status: 'unavailable'
                } as ProviderRateLimits)
              : await fetchViaOauthCreds(creds, antigravityCliOAuthEnabled)
          })()
    return result
  } catch (err) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : 'Unknown error',
      status: 'error'
    }
  }
}
