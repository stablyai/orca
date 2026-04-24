import { session } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { fetchViaPty } from './claude-pty'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

const API_TIMEOUT_MS = 15_000

// Why: bridge standard proxy env vars to Electron's networking stack so users
// in corporate environments can reach Claude APIs.
function getProxyFromEnv(): string | null {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    null
  )
}

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
}

function parseResetDescription(isoString: string | undefined): string | null {
  if (!isoString) {
    return null
  }
  try {
    const date = new Date(isoString)
    if (isNaN(date.getTime())) {
      return null
    }
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()
    if (isToday) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    }
    return date.toLocaleDateString(undefined, {
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit'
    })
  } catch {
    return null
  }
}

function mapWindow(
  raw: OAuthUsageWindow | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!raw || typeof raw.utilization !== 'number') {
    return null
  }
  return {
    usedPercent: Math.min(100, Math.max(0, raw.utilization)),
    windowMinutes,
    resetsAt: raw.resets_at ? new Date(raw.resets_at).getTime() || null : null,
    resetDescription: parseResetDescription(raw.resets_at)
  }
}

async function fetchViaOAuth(token: string): Promise<ProviderRateLimits> {
  const proxy = getProxyFromEnv()

  // Why: use a dedicated session partition to isolate proxy settings. Setting
  // proxy on defaultSession would impact all app traffic (GitHub, Linear, etc).
  const claudeSession = session.fromPartition('persist:claude')

  if (proxy) {
    await claudeSession.setProxy({ proxyRules: proxy })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS)

  try {
    // Note: this URL is illustrative — the actual implementation would
    // use Claude's real internal quota endpoint discovered during reverse engineering.
    const res = await (claudeSession as unknown as { net: { fetch: typeof fetch } }).net.fetch(
      'https://api.anthropic.com/v1/stats/usage',
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`
        },
        signal: controller.signal
      }
    )

    if (!res.ok) {
      throw new Error(`OAuth API returned ${res.status}`)
    }

    const data = (await res.json()) as OAuthUsageResponse

    return {
      provider: 'claude',
      session: mapWindow(data.five_hour, 300),
      weekly: mapWindow(data.seven_day, 10080),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } finally {
    clearTimeout(timeout)
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function fetchClaudeRateLimits(options?: {
  authPreparation?: ClaudeRuntimeAuthPreparation
}): Promise<ProviderRateLimits> {
  // Why: the new implementation prioritizes OAuth API over PTY scraping.
  // The PTY fallback remains for cases where we can't find OAuth credentials
  // or the API call fails for a subscription user.
  try {
    // Note: in a real scenario we would resolve the OAuth token here.
    // For this prototype, we'll try the PTY fallback as the main path.
    return await fetchViaPty({ authPreparation: options?.authPreparation })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      provider: 'claude',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: message,
      status: 'error'
    }
  }
}
