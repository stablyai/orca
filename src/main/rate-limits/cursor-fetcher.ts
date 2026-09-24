import { net } from 'electron'
import type { ProviderRateLimits, UsageRateLimitSource } from '../../shared/rate-limit-types'
import {
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'
import { cursorSessionCookie, isCursorSessionTokenExpired } from './cursor-session-token'
import {
  mapCursorLegacyRequestQuota,
  mapCursorUsageSummary,
  parseCursorUsageSummary
} from './cursor-usage-mapping'

const DASHBOARD_ORIGIN = 'https://cursor.com'
const USAGE_SUMMARY_URL = `${DASHBOARD_ORIGIN}/api/usage-summary`
const LEGACY_USAGE_URL = `${DASHBOARD_ORIGIN}/api/usage`
const API_TIMEOUT_MS = 10_000

const SIGNED_OUT_MESSAGE = 'Not signed in to Cursor — run `cursor-agent login`'
const EXPIRED_MESSAGE = 'Cursor sign-in expired — run `cursor-agent login` again'

function usageSource(session: CursorAuthSession): UsageRateLimitSource {
  return session.source === 'desktop' ? 'web' : 'cli'
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  extra: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...extra
  }
}

/**
 * Dashboard routes answer 403 to a bare session cookie — they check the request
 * origin as CSRF defence. Sending what the dashboard itself sends is what they
 * expect; without these headers every /api route fails on a valid session.
 */
function requestHeaders(session: CursorAuthSession): Record<string, string> {
  return {
    Cookie: cursorSessionCookie(session.token),
    Accept: 'application/json',
    Origin: DASHBOARD_ORIGIN,
    Referer: `${DASHBOARD_ORIGIN}/dashboard`
  }
}

type FetchOutcome = { kind: 'data'; data: unknown } | { kind: 'result'; result: ProviderRateLimits }

async function fetchDashboardJson(
  url: string,
  session: CursorAuthSession,
  signal?: AbortSignal
): Promise<FetchOutcome> {
  const source = usageSource(session)
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)
  const res = await net.fetch(url, {
    redirect: 'error',
    headers: requestHeaders(session),
    signal: requestSignal
  })
  if (res.status === 401 || res.status === 403) {
    return {
      kind: 'result',
      result: result('error', EXPIRED_MESSAGE, {
        usageMetadata: { source, credentialSource: session.source, failureKind: 'stale-token' }
      })
    }
  }
  if (res.status === 429) {
    const retryAfterSeconds = Number(res.headers.get('retry-after'))
    return {
      kind: 'result',
      result: result('error', 'Cursor usage is rate limited right now', {
        usageMetadata: {
          source,
          credentialSource: session.source,
          failureKind: 'rate-limited',
          ...(Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
            ? { retryAtMs: Date.now() + retryAfterSeconds * 1000 }
            : {})
        }
      })
    }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      result: result('error', `Cursor usage request failed (HTTP ${res.status})`, {
        usageMetadata: { source, credentialSource: session.source, failureKind: 'server' }
      })
    }
  }
  try {
    return { kind: 'data', data: await res.json() }
  } catch {
    return {
      kind: 'result',
      result: result('error', 'Cursor usage response could not be parsed', {
        usageMetadata: { source, credentialSource: session.source, failureKind: 'parse' }
      })
    }
  }
}

function credentialFailure(readResult: CursorAuthReadResult): ProviderRateLimits | null {
  if (readResult.status === 'missing') {
    return result('unavailable', SIGNED_OUT_MESSAGE, {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }
  if (readResult.status === 'error') {
    return result('error', readResult.error, {
      usageMetadata: { failureKind: 'missing-credentials' }
    })
  }
  // Why: cursor-agent refreshes its own token on use; Orca only reads, so a
  // lapsed session is reported instead of spending a request that must 401.
  if (isCursorSessionTokenExpired(readResult.session.token)) {
    return result('error', EXPIRED_MESSAGE, {
      usageMetadata: {
        source: usageSource(readResult.session),
        credentialSource: readResult.session.source,
        failureKind: 'stale-token'
      }
    })
  }
  return null
}

/**
 * Reads the Cursor plan allowance for the account this machine is signed into.
 * Orca never runs `cursor-agent login` and never writes Cursor's credentials.
 */
export async function fetchCursorRateLimits(
  options: { signal?: AbortSignal; authReadResult?: CursorAuthReadResult } = {}
): Promise<ProviderRateLimits> {
  const readResult = options.authReadResult ?? (await readCursorAuthSession())
  const failure = credentialFailure(readResult)
  if (failure || readResult.status !== 'ok') {
    return failure ?? result('unavailable', SIGNED_OUT_MESSAGE)
  }
  const session = readResult.session
  const source = usageSource(session)
  const metadata = { source, credentialSource: session.source }

  try {
    const outcome = await fetchDashboardJson(USAGE_SUMMARY_URL, session, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const mapped = mapCursorUsageSummary(parseCursorUsageSummary(outcome.data))

    // Why: an unlimited plan has no ceiling to divide by. Publish the plan so the
    // roster still lists the account, with no misleading bar.
    if (mapped.isUnlimited) {
      return result('ok', null, { planType: mapped.planType, usageMetadata: metadata })
    }
    if (mapped.monthly || mapped.buckets.length > 0) {
      return result('ok', null, {
        ...(mapped.monthly ? { monthly: mapped.monthly } : {}),
        ...(mapped.buckets.length > 0 ? { buckets: mapped.buckets } : {}),
        planType: mapped.planType,
        usageMetadata: metadata
      })
    }

    // Why: accounts still on request-quota billing report nothing under
    // individualUsage, so try the older per-model endpoint before concluding
    // the account has no visible quota.
    const legacy = await fetchDashboardJson(
      `${LEGACY_USAGE_URL}?user=${encodeURIComponent(session.token.subject)}`,
      session,
      options.signal
    )
    if (legacy.kind === 'result') {
      return legacy.result
    }
    const legacyWindow = mapCursorLegacyRequestQuota(legacy.data)
    if (legacyWindow) {
      return result('ok', null, {
        monthly: legacyWindow,
        planType: mapped.planType,
        usageMetadata: metadata
      })
    }

    // Why: a 200 with no allowance means the plan exposes no quota (API-key or
    // team-billed accounts). 'unavailable' hides the bar the way Claude does on
    // API-key billing; 'error' would paint a permanent alert for a healthy account.
    return result('unavailable', 'Cursor reported no usage allowance for this account', {
      planType: mapped.planType,
      usageMetadata: { ...metadata, failureKind: 'usage-unavailable' }
    })
  } catch {
    return result('error', 'Cursor usage request failed', {
      usageMetadata: { ...metadata, failureKind: 'network' }
    })
  }
}
