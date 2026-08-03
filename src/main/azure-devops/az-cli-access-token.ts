import { runAzAccessTokenCommand } from './az-cli-invocation'

/** Azure DevOps' fixed Entra application ID — identical for every tenant. */
export const AZURE_DEVOPS_ENTRA_RESOURCE_ID = '499b84ac-1321-427f-aa17-267ca6975798'

// Why: refresh before Entra's expiry so in-flight requests never carry a token
// that lapses mid-request.
const EXPIRY_MARGIN_MS = 5 * 60 * 1000

// Why: while az is missing or logged out every poll would otherwise pay a
// ~1s CLI spawn; back off, but short enough that a fresh `az login` is
// noticed without restarting Orca.
const FAILURE_COOLDOWN_MS = 60 * 1000

// Why: when az omits every expiry field the token still lapses after Entra's
// ~1h lifetime; a bounded cache re-acquires instead of serving 401s forever.
const UNKNOWN_EXPIRY_TTL_MS = 30 * 60 * 1000

type CachedToken = { token: string; expiresAtMs: number }

let cached: CachedToken | null = null
let failedAtMs: number | null = null
let inFlight: Promise<string | null> | null = null

function parseTokenResponse(stdout: string): CachedToken | null {
  const parsed = JSON.parse(stdout) as {
    accessToken?: unknown
    expires_on?: unknown
    expiresOn?: unknown
  }
  if (typeof parsed.accessToken !== 'string') {
    return null
  }
  // Why: expires_on (epoch, UTC) only exists on newer az; older versions emit
  // just expiresOn, a zone-less local-time string that Date.parse reads as local.
  let expiresAtMs =
    typeof parsed.expires_on === 'number'
      ? parsed.expires_on * 1000
      : typeof parsed.expiresOn === 'string'
        ? Date.parse(parsed.expiresOn)
        : Number.NaN
  if (!Number.isFinite(expiresAtMs)) {
    expiresAtMs = Date.now() + UNKNOWN_EXPIRY_TTL_MS
  }
  return { token: parsed.accessToken, expiresAtMs }
}

async function acquireToken(): Promise<string | null> {
  try {
    const stdout = await runAzAccessTokenCommand(AZURE_DEVOPS_ENTRA_RESOURCE_ID)
    cached = parseTokenResponse(stdout)
    failedAtMs = cached ? null : Date.now()
    return cached?.token ?? null
  } catch {
    failedAtMs = Date.now()
    return null
  }
}

export function getAzCliAzureDevOpsAccessToken(): Promise<string | null> {
  if (cached && Date.now() < cached.expiresAtMs - EXPIRY_MARGIN_MS) {
    return Promise.resolve(cached.token)
  }
  if (failedAtMs !== null && Date.now() < failedAtMs + FAILURE_COOLDOWN_MS) {
    return Promise.resolve(null)
  }
  // Why: concurrent polls during a cold cache must share one az spawn, not race N.
  inFlight ??= acquireToken().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Entra tokens only work for the hosted service, never on-prem Azure DevOps Server. */
export function isEntraEligibleAzureDevOpsBaseUrl(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return host === 'dev.azure.com' || host === 'visualstudio.com' || host.endsWith('.visualstudio.com')
}

export function _resetAzCliAccessTokenCacheForTests(): void {
  cached = null
  failedAtMs = null
  inFlight = null
}
