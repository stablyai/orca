import { execLocalPreflightCommand } from '../ipc/preflight-command-exec'

// Why: fixed Azure DevOps OAuth resource GUID accepted by Azure DevOps REST APIs.
const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const EXPIRY_SAFETY_MS = 60_000
const UNKNOWN_EXPIRY_CACHE_MS = 300_000
// Why: also cache the "no token" outcome briefly so an installed-but-logged-out
// `az` (or any failure) isn't re-spawned for every REST call in a status poll.
const NEGATIVE_CACHE_MS = 30_000

type AzCliToken = { token: string; expiresAtMs: number | null }

// Why: cache both success and failure outcomes. A separate validity flag avoids
// conflating "cached negative result" with "cache empty", so a negative result
// suppresses re-spawns until NEGATIVE_CACHE_MS elapses.
let cachedResult: AzCliToken | null = null
let hasCachedResult = false
let cacheUsableUntilMs = 0
let inFlightTokenRequest: Promise<AzCliToken | null> | null = null

function parseExpiresAtMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null
  }
  const expiresAtMs = value * 1000
  return Number.isFinite(expiresAtMs) ? expiresAtMs : null
}

async function acquireAzCliToken(): Promise<AzCliToken | null> {
  try {
    const { stdout } = await execLocalPreflightCommand('az', [
      'account',
      'get-access-token',
      '--resource',
      AZURE_DEVOPS_RESOURCE,
      '--output',
      'json'
    ])
    const parsed = JSON.parse(stdout) as { accessToken?: unknown; expires_on?: unknown }
    const token = typeof parsed.accessToken === 'string' ? parsed.accessToken.trim() : ''
    if (!token) {
      return null
    }
    return { token, expiresAtMs: parseExpiresAtMs(parsed.expires_on) }
  } catch {
    return null
  }
}

export async function getAzureDevOpsAzCliAccessToken(): Promise<AzCliToken | null> {
  const now = Date.now()
  if (hasCachedResult && now < cacheUsableUntilMs) {
    return cachedResult
  }
  if (inFlightTokenRequest) {
    return inFlightTokenRequest
  }

  inFlightTokenRequest = acquireAzCliToken().then((token) => {
    cachedResult = token
    hasCachedResult = true
    if (token) {
      cacheUsableUntilMs =
        token.expiresAtMs === null
          ? Date.now() + UNKNOWN_EXPIRY_CACHE_MS
          : token.expiresAtMs - EXPIRY_SAFETY_MS
    } else {
      cacheUsableUntilMs = Date.now() + NEGATIVE_CACHE_MS
    }
    return token
  })

  try {
    return await inFlightTokenRequest
  } finally {
    inFlightTokenRequest = null
  }
}

export function _resetAzCliTokenCache(): void {
  cachedResult = null
  hasCachedResult = false
  cacheUsableUntilMs = 0
  inFlightTokenRequest = null
}
