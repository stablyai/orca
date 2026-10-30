import type { Session } from 'electron'
import { randomUUID } from 'node:crypto'
import type { NetworkProxySettings } from '../../shared/network-proxy'
import type {
  ExtraUsageBalance,
  ProviderRateLimits,
  UsageRateLimitFailureKind
} from '../../shared/rate-limit-types'
import {
  clearOpenCodeSessionCookies,
  createOpenCodeRequestSession,
  OPENCODE_BASE_URL
} from './opencode-go-request-session'
import {
  isOpenCodeGoExplicitNoAccessPayload,
  makeOpenCodeGoZenBalance,
  parseOpenCodeGoBillingStatusPayload,
  parseOpenCodeGoStatusPayload
} from './opencode-go-status-parsing'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

const OPENCODE_SERVER_URL = 'https://opencode.ai/_server'
const OPENCODE_GO_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/go/status`
const OPENCODE_BILLING_STATUS_URL = `${OPENCODE_BASE_URL}/console/api/billing/status`
const API_TIMEOUT_MS = 15_000
const OPTIONAL_BILLING_TIMEOUT_MS = 5_000

// SST/TanStack workspaces server-function routing id.
const WORKSPACES_SERVER_ID = 'def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f'

// Send only known auth cookies: console usage needs __Host-console_session; workspace discovery uses auth.
const AUTH_COOKIE_NAMES = new Set(['auth', '__Host-auth', '__Host-console_session'])

// Accept pasted token values without requiring the auth= header syntax.
export function normalizeCookieInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return trimmed
  }
  if (trimmed.includes(';') || /^(?:auth|__Host-auth|__Host-console_session)=/i.test(trimmed)) {
    return trimmed
  }
  // Wrap only seal/structured token shapes; malformed values must fail predictably.
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
  // Console uses org_/wrk_; wk_ remains accepted for older workspace responses.
  const ids: string[] = []
  const workspaceIdRegex = /\bid\s*:\s*["']((?:org|wrk|wk)_[a-zA-Z0-9]+)["']/g
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

  // Exclude unrelated session data from requests.
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

  // Chromium may reject manual Cookie headers on Windows; use an isolated jar for normal auth attachment.
  let openCodeSession: Session
  try {
    openCodeSession = await createOpenCodeRequestSession(authCookies, networkProxySettings)
  } catch (error) {
    return makeOpenCodeError(error instanceof Error ? error.message : 'Unknown error')
  }

  try {
    return await fetchOpenCodeGoRateLimitsWithSession(openCodeSession, workspaceIdOverride)
  } finally {
    await clearOpenCodeSessionCookies(openCodeSession).catch((error: unknown) => {
      console.warn('[opencode-go] failed to clear session cookie jar after fetch', error)
    })
  }
}

function startOptionalBillingFetch(openCodeSession: Session, workspaceId: string) {
  const abortController = new AbortController()
  const promise = (async (): Promise<ExtraUsageBalance> => {
    const timeout = setTimeout(() => abortController.abort(), OPTIONAL_BILLING_TIMEOUT_MS)
    try {
      const response = await openCodeSession.fetch(OPENCODE_BILLING_STATUS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Origin: OPENCODE_BASE_URL,
          Referer: `${OPENCODE_BASE_URL}/console/${workspaceId}/billing`,
          'x-org-id': workspaceId
        },
        signal: abortController.signal
      })
      if (!response.ok) {
        abortController.abort()
        return makeOpenCodeGoZenBalance(null, 'refresh-failed')
      }
      const balance = parseOpenCodeGoBillingStatusPayload(await response.text())
      return makeOpenCodeGoZenBalance(balance, balance === null ? 'billing-unavailable' : null)
    } catch {
      return makeOpenCodeGoZenBalance(null, 'refresh-failed')
    } finally {
      clearTimeout(timeout)
    }
  })()
  return { promise, abort: () => abortController.abort() }
}

function makeOpenCodeError(
  error: string,
  failureKind?: UsageRateLimitFailureKind
): ProviderRateLimits {
  return {
    provider: 'opencode-go',
    session: null,
    weekly: null,
    monthly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    ...(failureKind ? { usageMetadata: { failureKind } } : {})
  }
}

async function fetchOpenCodeGoRateLimitsWithSession(
  openCodeSession: Session,
  workspaceIdOverride?: string
): Promise<ProviderRateLimits> {
  let ids: string[] = []
  const override = workspaceIdOverride?.trim()

  if (override) {
    if (!/^(org|wrk|wk)_[A-Za-z0-9]+$/.test(override)) {
      return makeOpenCodeError(
        'Invalid workspace ID format: must match ^(org|wrk|wk)_[A-Za-z0-9]+$'
      )
    }
    ids = [override]
  } else {
    try {
      // SST server functions route by query hash plus X-Server-Id/X-Server-Instance.
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
        return makeOpenCodeError(`Workspaces fetch failed (${workspacesRes.status})`)
      }

      const workspacesText = await workspacesRes.text()
      ids = parseWorkspaceIds(workspacesText)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return makeOpenCodeError(message, classifyThrownUsageRequestError(err))
    }
  }

  if (ids.length === 0) {
    return makeOpenCodeError(
      'No workspace found for this cookie — add an OpenCode Go API key (or run /connect in OpenCode), or set a Workspace ID override'
    )
  }

  // Legacy workspace Go pages redirect to login; JSON usage uses console session auth and x-org-id.
  let lastFailure: ProviderRateLimits | null = null
  let balanceOnlyResult: ProviderRateLimits | null = null
  for (const candidateId of ids) {
    let billingTask: ReturnType<typeof startOptionalBillingFetch> | null = null
    try {
      const statusPromise = openCodeSession.fetch(OPENCODE_GO_STATUS_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Origin: OPENCODE_BASE_URL,
          Referer: `${OPENCODE_BASE_URL}/console/${candidateId}/go`,
          'x-org-id': candidateId
        },
        signal: AbortSignal.timeout(API_TIMEOUT_MS)
      })
      billingTask = startOptionalBillingFetch(openCodeSession, candidateId)
      const statusRes = await statusPromise
      if (!statusRes.ok) {
        billingTask.abort()
        await billingTask.promise
        lastFailure = makeOpenCodeError(
          statusRes.status === 401
            ? 'Usage fetch failed (401) — paste the full Cookie header including __Host-console_session (auth alone is not enough)'
            : `Usage fetch failed (${statusRes.status})`
        )
        continue
      }

      const statusText = await statusRes.text()
      const parsed = parseOpenCodeGoStatusPayload(statusText)
      const explicitNoAccess = isOpenCodeGoExplicitNoAccessPayload(statusText)
      if (!parsed && !explicitNoAccess) {
        billingTask.abort()
        await billingTask.promise
        lastFailure = makeOpenCodeError('Could not parse usage data')
        continue
      }

      const balance = await billingTask.promise
      if (parsed) {
        return {
          provider: 'opencode-go',
          session: parsed.session,
          weekly: parsed.weekly,
          monthly: parsed.monthly,
          extraUsage: balance,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }
      }
      if (balance.balance !== null) {
        balanceOnlyResult ??= {
          provider: 'opencode-go',
          session: null,
          weekly: null,
          monthly: null,
          extraUsage: balance,
          updatedAt: Date.now(),
          error: null,
          status: 'ok'
        }
      } else {
        lastFailure = makeOpenCodeError('Could not parse usage data')
      }
    } catch (err) {
      if (billingTask) {
        billingTask.abort()
        await billingTask.promise
      }
      const message = err instanceof Error ? err.message : 'Unknown error'
      lastFailure = makeOpenCodeError(message, classifyThrownUsageRequestError(err))
    }
  }

  if (balanceOnlyResult) {
    return balanceOnlyResult
  }
  return lastFailure ?? makeOpenCodeError('Could not parse usage data from any available workspace')
}
