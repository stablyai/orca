import { net } from 'electron'
import { randomUUID } from 'crypto'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { parseSubscriptionFromPageText } from './opencode-go-page-scraper'

const OPENCODE_BASE_URL = 'https://opencode.ai'
const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const API_TIMEOUT_MS = 15_000

// Server-function hash for the workspaces endpoint — stable identifier used by
// the opencode.ai SST/TanStack router server-fn protocol.
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

// Only these cookie names carry session auth on opencode.ai. Sending unrelated
// cookies pollutes the header and can expose sensitive data from other sites.
const AUTH_COOKIE_NAMES = new Set(['auth', '__Host-auth'])

// Why: users may paste just the token value (e.g. "Fe26.2**...") instead of
// the full cookie header ("auth=Fe26.2**..."). Auto-wrapping avoids a confusing
// silent failure where the cookie looks non-empty but contains no auth name.
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return trimmed
  }
  // Already a valid cookie header: has multiple pairs or starts with known name.
  if (trimmed.includes(';') || /^(?:auth|__Host-auth)=/i.test(trimmed)) {
    return trimmed
  }
  // Only wrap if it looks like an Iron Session seal (starts with Fe26.2**)
  // or a reasonably structured bare token (alphanumeric with dots/dashes).
  // Otherwise, leave it alone to fail predictably instead of sending malformed auth.
  if (trimmed.startsWith('Fe26.2**') || /^[a-zA-Z0-9.\-_]+$/.test(trimmed)) {
    return `auth=${trimmed}`
  }
  return trimmed
}

function filterAuthCookie(raw: string): string {
  return raw
    .split(';')
    .map((p) => p.trim())
    .filter((pair) => {
      const eq = pair.indexOf('=')
      if (eq < 0) {
        return false
      }
      return AUTH_COOKIE_NAMES.has(pair.slice(0, eq).trim())
    })
    .join('; ')
}

function parseWorkspaceIds(text: string): string[] {
  // Match id:"wrk_..." or id: "wrk_..." patterns in JS-serialized output.
  // Why: Workspace IDs follow a 'wrk_xxx' or 'wk_xxx' pattern. Using a
  // more specific regex with word boundaries avoids picking up unrelated
  // object properties that might match a generic ID pattern.
  const ids: string[] = []
  const workspaceIdRegex = /\bid\s*:\s*["']((?:wrk|wk)_[a-zA-Z0-9]+)["']/g
  for (const match of text.matchAll(workspaceIdRegex)) {
    const id = match[1]
    if (id && !ids.includes(id)) {
      ids.push(id)
    }
  }
  return ids
}

function makeWindow(
  usedPercent: number,
  resetInSec: number,
  windowMinutes: number
): RateLimitWindow {
  return {
    usedPercent,
    windowMinutes,
    resetsAt: Date.now() + resetInSec * 1000,
    resetDescription: null
  }
}

export async function fetchOpenCodeGoRateLimits(
  cookie: string,
  workspaceIdOverride?: string
): Promise<ProviderRateLimits> {
  // Normalize before any guard — bare tokens become auth=<token>.
  const normalizedCookie = normalizeCookieInput(cookie)

  if (!normalizedCookie) {
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'Session cookie not configured',
      status: 'unavailable'
    }
  }

  // Filter to only auth cookies — avoids sending unrelated session data.
  const cookieHeader = filterAuthCookie(normalizedCookie)
  if (!cookieHeader) {
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No auth cookie found — paste the full Cookie header from opencode.ai DevTools',
      status: 'error'
    }
  }

  // Step 1: resolve workspace IDs to try.
  let ids: string[] = []
  const override = workspaceIdOverride?.trim()

  if (override) {
    if (!/^(wrk|wk)_[A-Za-z0-9]+$/.test(override)) {
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        monthly: null,
        updatedAt: Date.now(),
        error: 'Invalid workspace ID format: must match ^(wrk|wk)_[A-Za-z0-9]+$',
        status: 'error'
      }
    }
    ids = [override]
  } else {
    const workspacesController = new AbortController()
    const workspacesTimeout = setTimeout(() => workspacesController.abort(), API_TIMEOUT_MS)
    try {
      // The /_server endpoint uses SST server-function protocol: GET with ?id=<hash>
      // and X-Server-Id / X-Server-Instance headers for routing.
      const instanceId = `server-fn:${randomUUID()}`
      const workspacesUrl = `${OPENCODE_SERVER_URL}?id=${WORKSPACES_SERVER_ID}`
      const workspacesRes = await net.fetch(workspacesUrl, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          'X-Server-Id': WORKSPACES_SERVER_ID,
          'X-Server-Instance': instanceId,
          Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
          Origin: OPENCODE_BASE_URL,
          Referer: OPENCODE_BASE_URL
        },
        signal: workspacesController.signal
      })

      if (!workspacesRes.ok) {
        return {
          provider: 'opencode-go',
          session: null,
          weekly: null,
          monthly: null,
          updatedAt: Date.now(),
          error: `Workspaces fetch failed (${workspacesRes.status})`,
          status: 'error'
        }
      }

      const workspacesText = await workspacesRes.text()
      ids = parseWorkspaceIds(workspacesText)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return {
        provider: 'opencode-go',
        session: null,
        weekly: null,
        monthly: null,
        updatedAt: Date.now(),
        error: message,
        status: 'error'
      }
    } finally {
      clearTimeout(workspacesTimeout)
    }
  }

  if (ids.length === 0) {
    return {
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No workspace ID found — set a Workspace ID override in settings',
      status: 'error'
    }
  }

  // Step 2: Robust workspace resolution. Try each candidate ID until one returns 200 OK
  // and valid usage data. Each candidate gets its own AbortController so a slow or
  // hung candidate cannot starve the rest.
  let lastError = ''
  for (const candidateId of ids) {
    const candidateController = new AbortController()
    const candidateTimeout = setTimeout(() => candidateController.abort(), API_TIMEOUT_MS)
    try {
      const usagePageUrl = `${OPENCODE_BASE_URL}/workspace/${candidateId}/go`
      const pageRes = await net.fetch(usagePageUrl, {
        method: 'GET',
        headers: {
          Cookie: cookieHeader,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Origin: OPENCODE_BASE_URL,
          Referer: OPENCODE_BASE_URL
        },
        signal: candidateController.signal
      })

      if (!pageRes.ok) {
        lastError = `Usage page fetch failed (${pageRes.status})`
        continue
      }

      const pageText = await pageRes.text()
      const parsed = parseSubscriptionFromPageText(pageText)
      if (parsed) {
        const monthly =
          parsed.monthlyUsagePercent !== null && parsed.monthlyResetInSec !== null
            ? makeWindow(parsed.monthlyUsagePercent, parsed.monthlyResetInSec, 43200) // 30d
            : null

        return {
          provider: 'opencode-go',
          session: makeWindow(parsed.rollingUsagePercent, parsed.rollingResetInSec, 300),
          weekly: makeWindow(parsed.weeklyUsagePercent, parsed.weeklyResetInSec, 10080),
          monthly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }
      }
      lastError = 'Could not parse usage data from page'
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      lastError = message
    } finally {
      clearTimeout(candidateTimeout)
    }
  }

  return {
    provider: 'opencode-go',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error: lastError || 'Could not parse usage data from any available workspace',
    status: 'error'
  }
}
