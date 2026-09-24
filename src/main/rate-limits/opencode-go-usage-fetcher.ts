import type { Session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  clearOpenCodeSessionCookies,
  createOpenCodeRequestSession,
  OPENCODE_BASE_URL
} from './opencode-go-request-session'
import { parseOpenCodeGoStatusPayload } from './opencode-go-status-parsing'

const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const OPENCODE_GO_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/go/status`
const API_TIMEOUT_MS = 15_000

// Server-function hash for the workspaces endpoint — stable identifier used by
// the opencode.ai SST/TanStack router server-fn protocol.
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

// Closed allowlist: only known opencode.ai auth cookies. Console Go usage is
// authed by __Host-console_session; /_server workspace discovery still uses auth.
const AUTH_COOKIE_NAMES = new Set(['auth', '__Host-auth', '__Host-console_session'])

// Why: users may paste just the token value (e.g. "Fe26.2**...") instead of
// the full cookie header ("auth=Fe26.2**..."). Auto-wrapping avoids a confusing
// silent failure where the cookie looks non-empty but contains no auth name.
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return trimmed
  }
  // Already a valid cookie header: has multiple pairs or starts with known name.
  if (trimmed.includes(';') || /^(?:auth|__Host-auth|__Host-console_session)=/i.test(trimmed)) {
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

function parseAuthCookies(raw: string): { name: string; value: string }[] {
  return raw
    .split(';')
    .map((p) => p.trim())
    .map((pair) => {
      const eq = pair.indexOf('=')
      if (eq === -1) {
        return null
      }
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      return AUTH_COOKIE_NAMES.has(name) && value ? { name, value } : null
    })
    .filter((pair): pair is { name: string; value: string } => pair !== null)
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

export async function fetchOpenCodeGoRateLimits(
  cookie: string,
  workspaceIdOverride?: string,
  networkProxySettings?: NetworkProxySettings
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
  const authCookies = parseAuthCookies(normalizedCookie)
  if (authCookies.length === 0) {
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

  // Why: Chromium can reject a manually supplied Cookie header on Windows.
  // An isolated session jar lets its network stack attach auth normally.
  let openCodeSession: Session
  try {
    openCodeSession = await createOpenCodeRequestSession(authCookies, networkProxySettings)
  } catch (error) {
    return makeOpenCodeError(error)
  }

  try {
    return await fetchOpenCodeGoRateLimitsWithSession(openCodeSession, workspaceIdOverride)
  } finally {
    await clearOpenCodeSessionCookies(openCodeSession).catch((error: unknown) => {
      console.warn('[opencode-go] failed to clear session cookie jar after fetch', error)
    })
  }
}

function makeOpenCodeError(error: unknown): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error: error instanceof Error ? error.message : 'Unknown error',
    status: 'error'
  }
}

async function fetchOpenCodeGoRateLimitsWithSession(
  openCodeSession: Session,
  workspaceIdOverride?: string
): Promise<ProviderRateLimits> {
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
    try {
      // The /_server endpoint uses SST server-function protocol: GET with ?id=<hash>
      // and X-Server-Id / X-Server-Instance headers for routing.
      const instanceId = `server-fn:${randomUUID()}`
      const workspacesUrl = `${OPENCODE_SERVER_URL}?id=${WORKSPACES_SERVER_ID}`
      const workspacesRes = await openCodeSession.fetch(workspacesUrl, {
        method: 'GET',
        headers: {
          'X-Server-Id': WORKSPACES_SERVER_ID,
          'X-Server-Instance': instanceId,
          Accept: 'text/javascript, application/json;q=0.9, */*;q=0.8',
          Origin: OPENCODE_BASE_URL,
          Referer: OPENCODE_BASE_URL
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
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

  // Why: /workspace/<id>/go now 302s to console login. Usage is JSON at
  // /console/api/go/status, scoped by x-org-id and authed by the console session.
  let lastError = ''
  for (const candidateId of ids) {
    try {
      const statusRes = await openCodeSession.fetch(OPENCODE_GO_STATUS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Origin: OPENCODE_BASE_URL,
          Referer: `${OPENCODE_BASE_URL}/console/${candidateId}/go`,
          'x-org-id': candidateId
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      })

      if (!statusRes.ok) {
        lastError =
          statusRes.status === 401
            ? 'Usage fetch failed (401) — paste the full Cookie header including __Host-console_session (auth alone is not enough)'
            : `Usage fetch failed (${statusRes.status})`
        continue
      }

      const parsed = parseOpenCodeGoStatusPayload(await statusRes.text())
      if (parsed) {
        return {
          provider: 'opencode-go',
          session: parsed.session,
          weekly: parsed.weekly,
          monthly: parsed.monthly,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }
      }
      lastError = 'Could not parse usage data'
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      lastError = message
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
