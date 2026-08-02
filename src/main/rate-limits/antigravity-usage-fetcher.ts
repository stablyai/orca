import { net } from 'electron'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow,
  UsageRateLimitFailureKind,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import {
  AntigravityAuthError,
  getAntigravityAccessToken,
  invalidateAntigravityAccessToken,
  type AntigravityAccessToken
} from './antigravity-auth'
import {
  parseAntigravityQuotaBuckets,
  type AntigravityQuotaBucket
} from './antigravity-quota-parser'

export { parseAntigravityQuotaBuckets } from './antigravity-quota-parser'
export type { AntigravityQuotaBucket } from './antigravity-quota-parser'

const API_TIMEOUT_MS = 10_000
const API_BASE_URL = 'https://cloudcode-pa.googleapis.com'
const LOAD_CODE_ASSIST_URL = `${API_BASE_URL}/v1internal:loadCodeAssist`
const QUOTA_SUMMARY_URL = `${API_BASE_URL}/v1internal:retrieveUserQuotaSummary`
const LEGACY_QUOTA_URL = `${API_BASE_URL}/v1internal:retrieveUserQuota`
const ANTIGRAVITY_PLATFORM = 'PLATFORM_UNSPECIFIED'
const API_CLIENT_METADATA = {
  ideType: 'ANTIGRAVITY',
  platform: ANTIGRAVITY_PLATFORM,
  pluginType: 'GEMINI'
} as const

type AntigravityApiErrorOptions = {
  status?: number | null
  failureKind?: UsageRateLimitFailureKind
  retryAtMs?: number
}

class AntigravityApiError extends Error {
  readonly status: number | null
  readonly failureKind: UsageRateLimitFailureKind
  readonly retryAtMs: number | undefined

  constructor(message: string, options: AntigravityApiErrorOptions = {}) {
    super(message)
    this.name = 'AntigravityApiError'
    this.status = options.status ?? null
    this.failureKind = options.failureKind ?? 'unknown'
    this.retryAtMs = options.retryAtMs
  }
}

export type AntigravityFetcherOptions = {
  baseHomeDir?: string
  signal?: AbortSignal
}

export async function fetchAntigravityRateLimits(
  options: AntigravityFetcherOptions = {}
): Promise<ProviderRateLimits> {
  const { signal, baseHomeDir } = options
  try {
    const token = await getAntigravityAccessToken({ baseHomeDir, signal })
    return await fetchWithToken(token, { baseHomeDir, signal })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    return errorResult(error, null)
  }
}

async function fetchWithToken(
  token: AntigravityAccessToken,
  options: AntigravityFetcherOptions
): Promise<ProviderRateLimits> {
  let currentToken = token
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const projectId = await loadProjectId(currentToken.accessToken, options.signal)
      const quota = await loadQuota(projectId, currentToken.accessToken, options.signal)
      return quotaResult(quota, currentToken.credentialSource)
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      if (attempt === 0 && isUnauthorizedApiError(error)) {
        invalidateAntigravityAccessToken(currentToken.sourceKey)
        try {
          currentToken = await getAntigravityAccessToken({
            baseHomeDir: options.baseHomeDir,
            forceRefresh: true,
            signal: options.signal
          })
        } catch (refreshError) {
          return errorResult(refreshError, currentToken.credentialSource)
        }
        continue
      }
      return errorResult(error, currentToken.credentialSource)
    }
  }
  return errorResult(
    new AntigravityApiError('Antigravity quota request failed'),
    currentToken.credentialSource
  )
}

async function loadProjectId(accessToken: string, signal?: AbortSignal): Promise<string> {
  const data = await postJson(
    LOAD_CODE_ASSIST_URL,
    {
      metadata: API_CLIENT_METADATA
    },
    accessToken,
    signal
  )
  if (
    typeof data !== 'object' ||
    data === null ||
    !('cloudaicompanionProject' in data) ||
    typeof (data as { cloudaicompanionProject?: unknown }).cloudaicompanionProject !== 'string' ||
    !(data as { cloudaicompanionProject: string }).cloudaicompanionProject.trim()
  ) {
    throw new AntigravityApiError('Antigravity project ID is missing from the API response', {
      failureKind: 'parse'
    })
  }
  return (data as { cloudaicompanionProject: string }).cloudaicompanionProject
}

async function loadQuota(
  projectId: string,
  accessToken: string,
  signal?: AbortSignal
): Promise<AntigravityQuotaBucket[]> {
  let summaryError: AntigravityApiError | null = null
  try {
    const summary = await postJson(QUOTA_SUMMARY_URL, { project: projectId }, accessToken, signal)
    return parseAntigravityQuotaBuckets(summary)
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    if (!(error instanceof AntigravityApiError) || !isUnsupportedEndpoint(error.status)) {
      throw error
    }
    summaryError = error
  }

  // Why: only an explicitly unsupported summary endpoint may use the legacy
  // endpoint. Auth, network, rate-limit, and empty-success responses must not
  // fan out into a second request or silently change quota identity.
  try {
    const legacy = await postJson(LEGACY_QUOTA_URL, { project: projectId }, accessToken, signal)
    return parseAntigravityQuotaBuckets(legacy)
  } catch (error) {
    if (error instanceof AntigravityApiError && error.failureKind === 'usage-unavailable') {
      throw new AntigravityApiError(
        'Antigravity quota endpoint returned no recognized quota buckets',
        { status: summaryError?.status ?? null, failureKind: 'usage-unavailable' }
      )
    }
    throw error
  }
}

function quotaResult(
  buckets: AntigravityQuotaBucket[],
  credentialSource: string
): ProviderRateLimits {
  if (buckets.length === 0) {
    throw new AntigravityApiError(
      'Antigravity quota response contained no recognized quota buckets',
      { failureKind: 'usage-unavailable' }
    )
  }
  const session = buckets.find((entry) => entry.id === 'gemini-5h')?.bucket ?? null
  const weekly = buckets.find((entry) => entry.id === 'gemini-weekly')?.bucket ?? null
  return {
    provider: 'antigravity',
    session: session ? withoutName(session) : null,
    weekly: weekly ? withoutName(weekly) : null,
    buckets: buckets.map((entry) => entry.bucket),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: {
      source: 'oauth',
      credentialSource
    }
  }
}

function withoutName(bucket: RateLimitBucket): RateLimitWindow {
  const { name: _name, ...window } = bucket
  return window
}

async function postJson(
  url: string,
  body: unknown,
  accessToken: string,
  signal?: AbortSignal
): Promise<unknown> {
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  let response: Response
  try {
    response = await net.fetch(url, {
      method: 'POST',
      headers: antigravityHeaders(accessToken),
      body: JSON.stringify(body),
      signal: requestSignal
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new AntigravityApiError('Antigravity API request failed', { failureKind: 'network' })
  }
  if (!response.ok) {
    throw new AntigravityApiError(`Antigravity API request failed (HTTP ${response.status})`, {
      status: response.status,
      failureKind: failureKindForStatus(response.status),
      retryAtMs: getRetryAtMs(response)
    })
  }
  try {
    return await response.json()
  } catch {
    throw new AntigravityApiError('Antigravity API response is invalid', { failureKind: 'parse' })
  }
}

function antigravityHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': `antigravity/1.1.9 ${process.platform}/${process.arch}`,
    'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
    'Client-Metadata': JSON.stringify(API_CLIENT_METADATA)
  }
}

function failureKindForStatus(status: number): UsageRateLimitFailureKind {
  if (status === 401) {
    return 'stale-token'
  }
  if (status === 403) {
    return 'missing-scope'
  }
  if (status === 429) {
    return 'rate-limited'
  }
  if (status >= 500) {
    return 'server'
  }
  return 'unknown'
}

function getRetryAtMs(response: Response): number | undefined {
  const retryAfter = response.headers?.get('retry-after')
  if (!retryAfter) {
    return undefined
  }
  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) {
    return Date.now() + Math.max(0, seconds) * 1000
  }
  const date = Date.parse(retryAfter)
  return Number.isFinite(date) ? date : undefined
}

function isUnsupportedEndpoint(status: number | null): boolean {
  return status === 404 || status === 405 || status === 501
}

function isUnauthorizedApiError(error: unknown): error is AntigravityApiError {
  return error instanceof AntigravityApiError && error.status === 401
}

function errorResult(error: unknown, credentialSource: string | null): ProviderRateLimits {
  const metadata: UsageRateLimitMetadata = {
    source: 'oauth',
    ...(credentialSource ? { credentialSource } : {})
  }
  if (error instanceof AntigravityAuthError) {
    metadata.failureKind = error.failureKind
  } else if (error instanceof AntigravityApiError) {
    metadata.failureKind = error.failureKind
    if (error.retryAtMs !== undefined) {
      metadata.retryAtMs = error.retryAtMs
    }
  } else {
    metadata.failureKind = 'unknown'
  }
  const status =
    error instanceof AntigravityAuthError || error instanceof AntigravityApiError
      ? error.failureKind === 'missing-credentials'
        ? 'unavailable'
        : 'error'
      : 'error'
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    buckets: [],
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : 'Antigravity quota request failed',
    status,
    usageMetadata: metadata
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'name' in error && error.name === 'AbortError'
  )
}
