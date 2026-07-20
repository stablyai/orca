import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const API_BASE = 'https://api.commandcode.ai'
const CREDITS_PATH = '/internal/billing/credits'
const SUBSCRIPTIONS_PATH = '/internal/billing/subscriptions'
const API_TIMEOUT_MS = 15_000
const FIVE_HOUR_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080
const MONTHLY_WINDOW_MINUTES = 43_200

type CommandCodeCreditsPayload = {
  monthlyCredits: number
  purchasedCredits: number
  premiumMonthlyCredits: number
  opensourceMonthlyCredits: number
}

type CommandCodeWindowLimits = {
  fiveHour: Record<string, unknown> | null
  weekly: Record<string, unknown> | null
}

type CommandCodeSubscriptionPayload = {
  planId: string
  status: string
  currentPeriodEnd: string | null
}

// Why: Command Code uses `individual-{plan}` as the planId prefix.
const PLAN_CATALOG: Record<string, { displayName: string; monthlyCreditsUSD: number }> = {
  'individual-go': { displayName: 'Go', monthlyCreditsUSD: 10 },
  'individual-pro': { displayName: 'Pro', monthlyCreditsUSD: 30 },
  'individual-provider': { displayName: 'Provider', monthlyCreditsUSD: 0 },
  'individual-max_10x': { displayName: 'Max 10×', monthlyCreditsUSD: 150 },
  'individual-max_20x': { displayName: 'Max 20×', monthlyCreditsUSD: 300 },
  team_pro: { displayName: 'Team Pro', monthlyCreditsUSD: 40 },
  enterprise: { displayName: 'Enterprise', monthlyCreditsUSD: 0 }
}

function maybeDouble(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)))
}

function formatResetDescription(resetAtMs: number): string | null {
  if (!Number.isFinite(resetAtMs) || resetAtMs <= 0) {
    return null
  }
  const date = new Date(resetAtMs)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function parseWindow(
  windowData: Record<string, unknown> | null | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!windowData) {
    return null
  }
  const used = maybeDouble(windowData.used)
  const cap = maybeDouble(windowData.cap)
  if (used === undefined || cap === undefined || cap <= 0) {
    return null
  }
  const resetAt = maybeDouble(windowData.resetAt) ?? null
  return {
    usedPercent: clampPercent((used / cap) * 100),
    windowMinutes,
    resetsAt: resetAt && Number.isFinite(resetAt) ? resetAt : null,
    resetDescription: resetAt ? formatResetDescription(resetAt) : null
  }
}

function makeResult(
  status: ProviderRateLimits['status'],
  error: string | null
): ProviderRateLimits {
  return {
    provider: 'command-code',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

async function sendRequest(url: string, cookieHeader: string): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: cookieHeader,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: 'https://commandcode.ai',
    Referer: 'https://commandcode.ai/'
  }
  const signal = AbortSignal.timeout(API_TIMEOUT_MS)
  return net.fetch(url, { headers, signal })
}

async function fetchCredits(
  cookieHeader: string
): Promise<{ credits: CommandCodeCreditsPayload; windows: CommandCodeWindowLimits } | null> {
  const url = `${API_BASE}${CREDITS_PATH}`
  const response = await sendRequest(url, cookieHeader)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as Record<string, unknown>
  const credits = data.credits as Record<string, unknown> | undefined
  if (!credits) {
    return null
  }
  const monthlyCredits = maybeDouble(credits.monthlyCredits)
  if (monthlyCredits === undefined) {
    return null
  }

  const wl = data.windowLimits as Record<string, unknown> | undefined
  const windows: CommandCodeWindowLimits = {
    fiveHour: wl?.fiveHour ? (wl.fiveHour as Record<string, unknown>) : null,
    weekly: wl?.weekly ? (wl.weekly as Record<string, unknown>) : null
  }

  return {
    credits: {
      monthlyCredits,
      purchasedCredits: maybeDouble(credits.purchasedCredits) ?? 0,
      premiumMonthlyCredits: maybeDouble(credits.premiumMonthlyCredits) ?? 0,
      opensourceMonthlyCredits: maybeDouble(credits.opensourceMonthlyCredits) ?? 0
    },
    windows
  }
}

async function fetchSubscription(
  cookieHeader: string
): Promise<CommandCodeSubscriptionPayload | null> {
  const url = `${API_BASE}${SUBSCRIPTIONS_PATH}`
  const response = await sendRequest(url, cookieHeader)
  if (!response.ok) {
    return null
  }
  const data = (await response.json()) as Record<string, unknown>
  if (data.success !== true) {
    return null
  }
  const sub = data.data as Record<string, unknown> | null
  if (!sub) {
    return null
  }
  const planId = typeof sub.planId === 'string' ? sub.planId : ''
  if (!planId) {
    return null
  }
  return {
    planId,
    status: typeof sub.status === 'string' ? sub.status : 'unknown',
    currentPeriodEnd: typeof sub.currentPeriodEnd === 'string' ? sub.currentPeriodEnd : null
  }
}

function buildAuthProvenance(
  planInfo: { displayName: string } | undefined,
  credits: CommandCodeCreditsPayload
): string {
  const parts: string[] = []
  if (planInfo) {
    parts.push(planInfo.displayName)
  }
  if (credits.purchasedCredits > 0) {
    parts.push(`+ $${credits.purchasedCredits.toFixed(2)} extra credits`)
  }
  return parts.length > 0 ? parts.join(' · ') : 'Command Code'
}

export async function fetchCommandCodeRateLimits(args: {
  cookieHeader: string
}): Promise<ProviderRateLimits> {
  const { cookieHeader } = args

  if (!cookieHeader || !cookieHeader.trim()) {
    return makeResult('unavailable', 'No Command Code session cookie configured')
  }

  const trimmedCookie = cookieHeader.trim()
  const standardHeader = trimmedCookie.startsWith('Cookie:')
    ? trimmedCookie
    : /^[A-Za-z0-9_.-]+=/.test(trimmedCookie)
      ? trimmedCookie
      : `Cookie: ${trimmedCookie}`

  try {
    const result = await fetchCredits(standardHeader)
    if (!result) {
      return makeResult('error', 'Command Code credits request failed — session may be expired')
    }

    const { credits, windows } = result

    const fiveHourWindow = parseWindow(windows.fiveHour, FIVE_HOUR_WINDOW_MINUTES)
    const weeklyWindow = parseWindow(windows.weekly, WEEKLY_WINDOW_MINUTES)

    // Best-effort subscription enrichment for plan name, billing reset, and
    // a precise monthly allocation from the plan catalog.
    let planInfo: { displayName: string; monthlyCreditsUSD: number } | undefined
    let periodEnd: string | null = null
    try {
      const sub = await fetchSubscription(standardHeader)
      if (sub) {
        planInfo = PLAN_CATALOG[sub.planId]
        periodEnd = sub.currentPeriodEnd
      }
    } catch {
      // Best-effort
    }

    let monthly: RateLimitWindow | null = null

    // Prefer the plan's monthly allocation from the subscription so the bar
    // matches the billing cycle. Fall back to the credits payload's own
    // premium + opensource totals when the subscription is unavailable.
    const monthlyTotal = planInfo?.monthlyCreditsUSD
      ? planInfo.monthlyCreditsUSD
      : credits.premiumMonthlyCredits + credits.opensourceMonthlyCredits

    if (monthlyTotal > 0) {
      const used = Math.max(0, monthlyTotal - credits.monthlyCredits)
      monthly = {
        usedPercent: clampPercent((used / monthlyTotal) * 100),
        windowMinutes: MONTHLY_WINDOW_MINUTES,
        resetsAt: null,
        resetDescription: null
      }
      const resetsAt = periodEnd ? Date.parse(periodEnd) : null
      if (resetsAt && Number.isFinite(resetsAt)) {
        monthly.resetsAt = resetsAt
        const date = new Date(resetsAt)
        monthly.resetDescription = date.toLocaleDateString(undefined, {
          weekday: 'short',
          month: 'short',
          day: 'numeric'
        })
      }
    }

    const hasAnyWindow = fiveHourWindow || weeklyWindow || monthly

    return {
      provider: 'command-code',
      session: fiveHourWindow,
      weekly: weeklyWindow,
      monthly,
      updatedAt: Date.now(),
      error: hasAnyWindow ? null : 'Command Code credits unavailable',
      status: hasAnyWindow ? 'ok' : 'unavailable',
      usageMetadata: {
        source: 'web',
        authProvenance: buildAuthProvenance(planInfo, credits)
      }
    }
  } catch (error) {
    return makeResult(
      'error',
      error instanceof Error ? error.message : 'Command Code usage request failed'
    )
  }
}
