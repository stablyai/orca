import { net } from 'electron'
import type {
  AntigravityModelsResponse,
  AntigravityQuotaSummaryResponse
} from './antigravity-quota-aggregation'

const API_TIMEOUT_MS = 15_000
export const ANTIGRAVITY_USER_AGENT = 'vscode/1.X.X (Antigravity/4.2.1)'
// Why: some accounts are served by pre-production quota hosts before the production host.
const ANTIGRAVITY_BASES = [
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://daily-cloudcode-pa.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
] as const

type AntigravityTier = {
  isDefault?: boolean
  id?: string
  name?: string
}

type AntigravityLoadResponse = {
  cloudaicompanionProject?: string
  paidTier?: AntigravityTier
  currentTier?: AntigravityTier
  allowedTiers?: AntigravityTier[]
  ineligibleTiers?: { reasonCode?: string }[]
}

function getAntigravityOAuthClient(): { clientId: string; clientSecret: string } | null {
  // Why: never hardcode Antigravity's public native OAuth client in source.
  // Set ANTIGRAVITY_CLIENT_ID / ANTIGRAVITY_CLIENT_SECRET in the environment
  // (dev shell or packaging) when token refresh is required; still-valid
  // access tokens from Credential Manager work without these.
  const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim()
  const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) {
    return null
  }
  return { clientId, clientSecret }
}

function withRequestTimeout(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(API_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

export async function refreshAntigravityAccessToken(
  refreshToken: string,
  signal?: AbortSignal
): Promise<string | null> {
  const client = getAntigravityOAuthClient()
  if (!client) {
    return null
  }
  const res = await net.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': ANTIGRAVITY_USER_AGENT
    },
    body: new URLSearchParams({
      client_id: client.clientId,
      client_secret: client.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString(),
    signal: withRequestTimeout(signal)
  })
  if (!res.ok) {
    return null
  }
  const data = (await res.json()) as { access_token?: string }
  return typeof data.access_token === 'string' ? data.access_token : null
}

function extractSubscriptionTier(data: AntigravityLoadResponse): string | null {
  let tier = data.paidTier?.name ?? data.paidTier?.id ?? null
  const ineligible = Array.isArray(data.ineligibleTiers) && data.ineligibleTiers.length > 0
  if (!tier && !ineligible) {
    tier = data.currentTier?.name ?? data.currentTier?.id ?? null
  }
  if (!tier && data.allowedTiers) {
    const defaultTier = data.allowedTiers.find((t) => t.isDefault === true)
    if (defaultTier) {
      const name = defaultTier.name ?? defaultTier.id
      if (name) {
        tier = `${name} (Restricted)`
      }
    }
  }
  return tier
}

async function postJson(
  url: string,
  accessToken: string,
  body: unknown,
  signal?: AbortSignal
): Promise<{ ok: true; status: number; data: unknown } | { ok: false; status: number }> {
  const res = await net.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': ANTIGRAVITY_USER_AGENT
    },
    body: JSON.stringify(body),
    signal: withRequestTimeout(signal)
  })
  if (!res.ok) {
    return { ok: false, status: res.status }
  }
  const data = (await res.json()) as unknown
  return { ok: true, status: res.status, data }
}

export async function fetchAntigravityCodeAssist(
  accessToken: string,
  signal?: AbortSignal
): Promise<{ projectId: string | null; subscriptionTier: string | null }> {
  for (const base of ANTIGRAVITY_BASES) {
    const result = await postJson(
      `${base}/v1internal:loadCodeAssist`,
      accessToken,
      {
        metadata: { ideType: 'ANTIGRAVITY' }
      },
      signal
    )
    if (!result.ok) {
      if (result.status === 401) {
        break
      }
      continue
    }
    const data = result.data as AntigravityLoadResponse
    const projectRaw = data.cloudaicompanionProject
    const projectId =
      typeof projectRaw === 'string' && projectRaw.length > 0
        ? (projectRaw.split('/').pop() ?? projectRaw)
        : null
    return { projectId, subscriptionTier: extractSubscriptionTier(data) }
  }
  return { projectId: null, subscriptionTier: null }
}

async function fetchWithProjectBodies(
  path: string,
  accessToken: string,
  projectId: string | null,
  signal?: AbortSignal
): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  let lastStatus = 0
  for (const base of ANTIGRAVITY_BASES) {
    const bodies: unknown[] =
      projectId && projectId.length > 0 ? [{ project: projectId }, {}] : [{}]
    for (const body of bodies) {
      const result = await postJson(`${base}${path}`, accessToken, body, signal)
      if (result.ok) {
        return { ok: true, data: result.data }
      }
      lastStatus = result.status
      if (result.status === 401) {
        return { ok: false, status: 401 }
      }
      // Why: 403 may be project-scoped, so retry the unscoped body on the same host.
      if (result.status === 403) {
        continue
      }
      // 429/5xx: try next base; other 4xx stop body retries for this base.
      if (result.status >= 400 && result.status < 500 && result.status !== 429) {
        break
      }
      break
    }
  }
  return { ok: false, status: lastStatus }
}

export async function fetchAntigravityModels(
  accessToken: string,
  projectId: string | null,
  signal?: AbortSignal
): Promise<AntigravityModelsResponse | { errorStatus: number }> {
  const result = await fetchWithProjectBodies(
    '/v1internal:fetchAvailableModels',
    accessToken,
    projectId,
    signal
  )
  if (!result.ok) {
    return { errorStatus: result.status }
  }
  return (result.data ?? { models: {} }) as AntigravityModelsResponse
}

export async function fetchAntigravityQuotaSummary(
  accessToken: string,
  projectId: string | null,
  signal?: AbortSignal
): Promise<AntigravityQuotaSummaryResponse | { errorStatus: number }> {
  const result = await fetchWithProjectBodies(
    '/v1internal:retrieveUserQuotaSummary',
    accessToken,
    projectId,
    signal
  )
  if (!result.ok) {
    return { errorStatus: result.status }
  }
  return (result.data ?? { groups: [] }) as AntigravityQuotaSummaryResponse
}
