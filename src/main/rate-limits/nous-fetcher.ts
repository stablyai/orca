import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  isTrustedNousPortalBaseUrl,
  readNousAuthSession,
  type NousAuthReadResult
} from './nous-auth'
import { asFiniteNumber, resolveAccessToken, withEndpointDeadline } from './nous-oauth'

// Why: the portal subscription runs on a calendar-month cycle (cycleEndsAt).
const NOUS_MONTHLY_WINDOW_MINUTES = 43_200

export type FetchNousRateLimitsOptions = {
  authReadResult?: NousAuthReadResult
  signal?: AbortSignal
}

type NousSubscriptionPayload = {
  current?: {
    tierId?: unknown
    tierName?: unknown
    monthlyCredits?: unknown
    creditsRemaining?: unknown
    cycleEndsAt?: unknown
  } | null
}

type NousCreditsInfo = NonNullable<ProviderRateLimits['nousCredits']>

type NousPaidServiceAccessPayload = {
  subscription_credits_remaining?: unknown
  purchased_credits_remaining?: unknown
  total_usable_credits?: unknown
}

function makeUnavailable(error: string): ProviderRateLimits {
  return {
    provider: 'nous',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'unavailable',
    usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
  }
}

function makeError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'nous',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)))
}

// Why: credits are decimal end-to-end; round to one decimal so the bar text
// stays compact ("580 | 420", "142.5") without drifting float artifacts.
function roundAmount(value: number): number {
  return Math.round(value * 10) / 10
}

// ─── Subscription fetch ────────────────────────────────────────────────────

function parseCycleEndsAt(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null
  }
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

function buildMonthlyWindow(current: NousSubscriptionPayload['current']): RateLimitWindow | null {
  if (!current) {
    return null
  }
  const monthlyCredits = asFiniteNumber(current.monthlyCredits)
  const creditsRemaining = asFiniteNumber(current.creditsRemaining)
  if (monthlyCredits === null || creditsRemaining === null || monthlyCredits <= 0) {
    return null
  }
  const used = Math.max(0, monthlyCredits - creditsRemaining)
  return {
    usedPercent: clampPercent((used / monthlyCredits) * 100),
    windowMinutes: NOUS_MONTHLY_WINDOW_MINUTES,
    resetsAt: parseCycleEndsAt(current.cycleEndsAt),
    resetDescription: null,
    usedAmount: roundAmount(used),
    remainingAmount: roundAmount(Math.max(0, creditsRemaining))
  }
}

// ─── Account credit breakdown (subscription vs top-up) ─────────────────────
// Why: top-up (prepaid) credits live on /api/oauth/account under
// paid_service_access.* — the /api/billing/subscription payload carries only
// the monthly plan window. Mirror the Hermes CLI /usage credits view, which
// reads the same snake_case fields, so Orca shows subscription + top-up.

function buildNousCredits(payload: unknown): NousCreditsInfo | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const access = (payload as Record<string, unknown>).paid_service_access
  if (typeof access !== 'object' || access === null) {
    return null
  }
  const record = access as NousPaidServiceAccessPayload
  const subscriptionRemaining = asFiniteNumber(record.subscription_credits_remaining)
  const topUpRemaining = asFiniteNumber(record.purchased_credits_remaining)
  const totalUsable = asFiniteNumber(record.total_usable_credits)
  if (subscriptionRemaining === null && topUpRemaining === null && totalUsable === null) {
    return null
  }
  return { subscriptionRemaining, topUpRemaining, totalUsable }
}

async function fetchNousAccountCredits(
  portalBaseUrl: string,
  token: string,
  signal?: AbortSignal
): Promise<NousCreditsInfo | null> {
  try {
    const response = await fetch(`${portalBaseUrl}/api/oauth/account`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`
      },
      signal: withEndpointDeadline(signal)
    })
    if (!response.ok) {
      return null
    }
    const payload: unknown = await response.json()
    return buildNousCredits(payload)
  } catch {
    // Why: the breakdown is an enhancement on top of the subscription window;
    // a failure here must never downgrade the subscription snapshot.
    return null
  }
}

export async function fetchNousRateLimits(
  options: FetchNousRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const authReadResult = options.authReadResult ?? readNousAuthSession()
  if (authReadResult.status !== 'ok') {
    return makeUnavailable(
      authReadResult.status === 'error'
        ? authReadResult.error
        : 'Nous Portal login not found — run `hermes portal` to sign in.'
    )
  }
  // Why: an injected session (tests) or future callers must not bypass the
  // auth-file trust boundary — never fetch against a non-canonical portal host.
  if (!isTrustedNousPortalBaseUrl(authReadResult.session.portalBaseUrl)) {
    return makeError('Nous Portal base URL is not trusted.', 'stale-token')
  }
  const resolved = await resolveAccessToken(authReadResult.session, options.signal)
  if ('error' in resolved) {
    return makeError(resolved.error, resolved.kind)
  }
  try {
    const [response, nousCredits] = await Promise.all([
      fetch(`${authReadResult.session.portalBaseUrl}/api/billing/subscription`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${resolved.token}`
        },
        signal: withEndpointDeadline(options.signal)
      }),
      fetchNousAccountCredits(authReadResult.session.portalBaseUrl, resolved.token, options.signal)
    ])
    if (response.status === 401 || response.status === 403) {
      return makeError(
        'Nous Portal session expired — run `hermes portal` to sign in again.',
        'stale-token'
      )
    }
    if (!response.ok) {
      return makeError(`Nous Portal usage fetch failed (${response.status})`, 'server')
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid Nous Portal usage response'
      return makeError(message, 'parse')
    }
    if (typeof payload !== 'object' || payload === null) {
      return makeError('Nous Portal usage returned an invalid response.', 'parse')
    }
    const current = (payload as NousSubscriptionPayload).current
    const tierName =
      current && typeof current.tierName === 'string' && current.tierName.trim()
        ? current.tierName.trim()
        : null
    return {
      provider: 'nous',
      session: null,
      weekly: null,
      monthly: buildMonthlyWindow(current),
      planType: tierName,
      nousCredits,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown Nous Portal usage error'
    return makeError(message, 'network')
  }
}
