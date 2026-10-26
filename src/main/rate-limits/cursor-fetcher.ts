import { createHash } from 'node:crypto'
import { getMainHttpClient } from '../network/http-client'
import type { ProviderRateLimits, UsageRateLimitSource } from '../../shared/rate-limit-types'
import { abortSignalWithTimeout } from '../lib/abort-signal-with-timeout'
import {
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'
import { cursorSessionCookie, isCursorSessionTokenExpired } from './cursor-session-token'
import {
  mapCursorCurrentPeriodUsage,
  type CursorCurrentPeriodUsage,
  mapCursorLegacyRequestQuota,
  mapCursorUsageSummary,
  parseCursorUsageSummary
} from './cursor-usage-mapping'
import { CURSOR_ON_DEMAND_BUCKET_NAME } from '../../shared/cursor-usage-buckets'
import { parseUsageRetryAfterMs } from './usage-retry-after'

const DASHBOARD_ORIGIN = 'https://cursor.com'
const USAGE_SUMMARY_URL = `${DASHBOARD_ORIGIN}/api/usage-summary`
const CURRENT_PERIOD_USAGE_URL = `${DASHBOARD_ORIGIN}/api/dashboard/get-current-period-usage`
const LEGACY_USAGE_URL = `${DASHBOARD_ORIGIN}/api/usage`
const API_TIMEOUT_MS = 10_000
// Shorter than any monthly billing cycle (28-31 days), e.g. a weekly Premium seat.
const SUB_MONTHLY_PERIOD_MINUTES = 27 * 24 * 60

const SIGNED_OUT_MESSAGE =
  'No Cursor sign-in on this computer — sign in with Cursor IDE or `cursor-agent login`'
const EXPIRED_MESSAGE = 'Cursor sign-in expired — run `cursor-agent login` again'

function usageSource(session: CursorAuthSession): UsageRateLimitSource {
  return session.source === 'desktop' ? 'web' : 'cli'
}

/** Hash the account subject: renderer/mobile snapshots only need equality, not the raw identifier. */
function accountFingerprint(session: CursorAuthSession): string {
  return createHash('sha256').update(session.token.subject).digest('hex').slice(0, 12)
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

/** Match dashboard CSRF origin headers; bare session cookies receive 403. */
function requestHeaders(session: CursorAuthSession): Record<string, string> {
  return {
    Cookie: cursorSessionCookie(session.token),
    Accept: 'application/json',
    Origin: DASHBOARD_ORIGIN,
    Referer: `${DASHBOARD_ORIGIN}/dashboard`
  }
}

type FetchOutcome =
  | { kind: 'data'; data: unknown }
  | { kind: 'result'; result: ProviderRateLimits; httpStatus?: number }

async function fetchDashboardJson(
  url: string,
  session: CursorAuthSession,
  signal?: AbortSignal,
  method: 'GET' | 'POST' = 'GET'
): Promise<FetchOutcome> {
  const source = usageSource(session)
  // Even failed refreshes need account provenance so switching accounts can discard stale quota.
  const provenance = accountFingerprint(session)
  const res = await getMainHttpClient().fetch(url, {
    // Keep dashboard redirects visible without forwarding session credentials.
    redirect: 'manual',
    // The selected account's Cookie must not be replaced by Electron's session jar.
    credentials: 'omit',
    headers: {
      ...requestHeaders(session),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
    },
    ...(method === 'POST' ? { method, body: '{}' } : {}),
    signal: abortSignalWithTimeout(signal, API_TIMEOUT_MS)
  })
  if (res.status === 401) {
    return {
      kind: 'result',
      result: result('error', EXPIRED_MESSAGE, {
        usageMetadata: {
          source,
          credentialSource: session.source,
          authProvenance: provenance,
          failureKind: 'stale-token'
        }
      })
    }
  }
  if (res.status === 429) {
    const nowMs = Date.now()
    const retryAfterMs = parseUsageRetryAfterMs(res.headers.get('retry-after'), nowMs)
    return {
      kind: 'result',
      result: result('error', 'Cursor usage is rate limited right now', {
        usageMetadata: {
          source,
          credentialSource: session.source,
          authProvenance: provenance,
          failureKind: 'rate-limited',
          ...(retryAfterMs !== null ? { retryAtMs: nowMs + retryAfterMs } : {})
        }
      })
    }
  }
  if (!res.ok) {
    return {
      kind: 'result',
      httpStatus: res.status,
      result: result('error', `Cursor usage request failed (HTTP ${res.status})`, {
        usageMetadata: {
          source,
          credentialSource: session.source,
          authProvenance: provenance,
          failureKind: 'server'
        }
      })
    }
  }
  try {
    return { kind: 'data', data: await res.json() }
  } catch {
    return {
      kind: 'result',
      result: result('error', 'Cursor usage response could not be parsed', {
        usageMetadata: {
          source,
          credentialSource: session.source,
          authProvenance: provenance,
          failureKind: 'parse'
        }
      })
    }
  }
}

type CurrentPeriodOutcome =
  | { kind: 'usage'; usage: CursorCurrentPeriodUsage }
  | { kind: 'result'; result: ProviderRateLimits }
  | { kind: 'summary' }

/** Unified plans use the period; other plans use it only for sub-monthly billing. */
async function fetchCurrentPeriodUsage(
  session: CursorAuthSession,
  signal: AbortSignal | undefined,
  unified: boolean
): Promise<CurrentPeriodOutcome> {
  let current: FetchOutcome
  try {
    current = await fetchDashboardJson(CURRENT_PERIOD_USAGE_URL, session, signal, 'POST')
  } catch (error) {
    if (unified) {
      throw error
    }
    return { kind: 'summary' }
  }
  if (current.kind === 'result') {
    // Only retired routes (including HTML app-shell replies) justify fallback; other failures must not publish obsolete zeros.
    const retired =
      [404, 405, 501].includes(current.httpStatus ?? 0) ||
      current.result.usageMetadata?.failureKind === 'parse'
    return unified && !retired ? { kind: 'result', result: current.result } : { kind: 'summary' }
  }
  const usage = mapCursorCurrentPeriodUsage(current.data)
  return usage && (unified || usage.periodMinutes < SUB_MONTHLY_PERIOD_MINUTES)
    ? { kind: 'usage', usage }
    : { kind: 'summary' }
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
  // Orca reads tokens only; report expiry and let cursor-agent refresh on next use.
  if (isCursorSessionTokenExpired(readResult.session.token)) {
    return result('error', EXPIRED_MESSAGE, {
      usageMetadata: {
        source: usageSource(readResult.session),
        credentialSource: readResult.session.source,
        authProvenance: accountFingerprint(readResult.session),
        failureKind: 'stale-token'
      }
    })
  }
  return null
}

/** Read Cursor allowance without running login or writing credentials. */
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
  const metadata = {
    source,
    credentialSource: session.source,
    authProvenance: accountFingerprint(session)
  }

  try {
    const outcome = await fetchDashboardJson(USAGE_SUMMARY_URL, session, options.signal)
    if (outcome.kind === 'result') {
      return outcome.result
    }
    const mapped = mapCursorUsageSummary(parseCursorUsageSummary(outcome.data))

    const unified = mapped.planType?.startsWith('unified_') === true
    const planPools = mapped.buckets.filter(
      (bucket) => bucket.name !== CURSOR_ON_DEMAND_BUCKET_NAME
    )
    // Weekly plans can leave obsolete monthly zeros; probe idle finite pools while retaining unlimited plans' no-bar result.
    const summaryPoolsIdle =
      !mapped.isUnlimited &&
      planPools.length > 0 &&
      planPools.every((bucket) => bucket.usedPercent === 0)
    if (unified || summaryPoolsIdle) {
      const current = await fetchCurrentPeriodUsage(session, options.signal, unified)
      if (current.kind === 'result') {
        return current.result
      }
      if (current.kind === 'usage') {
        const period = current.usage
        return result('ok', null, {
          ...(period.monthly ? { monthly: period.monthly } : {}),
          buckets: [
            ...period.buckets,
            ...mapped.buckets.filter((bucket) => bucket.name === CURSOR_ON_DEMAND_BUCKET_NAME)
          ],
          planType: mapped.planType,
          usageMetadata: metadata
        })
      }
    }

    // Unlimited plans retain account/plan identity without a misleading quota bar.
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

    // Older request-quota plans lack individualUsage; try per-model quotas before declaring no allowance.
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

    // Successful allowance-free plans are unavailable, not permanently failing; hide their bar.
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
