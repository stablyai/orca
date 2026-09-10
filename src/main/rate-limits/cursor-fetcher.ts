import { net } from 'electron'
import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'
import {
  cursorUsageSummaryCookie,
  readCursorAuthSession,
  type CursorAuthReadResult,
  type CursorAuthSession
} from './cursor-auth'
import {
  mapCursorSandUsage,
  mapCursorUsageSummary,
  type CursorSandUsage,
  type CursorUsageSummary
} from './cursor-usage-mapping'
import { withRateLimitRequestTimeout } from './rate-limit-request-timeout'

export {
  CURSOR_GROK_BOT_BUCKET,
  CURSOR_MODELS_BUCKET,
  CURSOR_OTHER_BUCKET,
  mapCursorSandUsage,
  mapCursorUsageSummary
} from './cursor-usage-mapping'

const USAGE_SUMMARY_URL = 'https://cursor.com/api/usage-summary'
const SAND_USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus'
const API_TIMEOUT_MS = 10_000

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata,
  extras: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'cursor',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {}),
    ...extras
  }
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  init: { method?: string; body?: string; signal?: AbortSignal } = {}
): Promise<{ status: number; data: unknown }> {
  const signal = withRateLimitRequestTimeout(init.signal, API_TIMEOUT_MS)
  const response = await net.fetch(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body,
    signal
  })
  try {
    return { status: response.status, data: await response.json() }
  } catch {
    return { status: response.status, data: null }
  }
}

function usageMetadata(
  session: CursorAuthSession,
  planType: string | null,
  extras: Partial<UsageRateLimitMetadata> = {}
): UsageRateLimitMetadata {
  const identity = session.email ?? (session.source === 'cli' ? 'Cursor CLI' : 'Cursor account')
  const provenance = [identity, planType, session.subscriptionStatus].filter(Boolean).join(' · ')
  return {
    source: session.source === 'cli' ? 'cli' : 'oauth',
    credentialSource: session.source,
    authProvenance: provenance,
    ...(session.email ? { accountEmail: session.email } : {}),
    ...(session.subscriptionStatus ? { subscriptionStatus: session.subscriptionStatus } : {}),
    ...extras
  }
}

function record(data: unknown): Record<string, unknown> {
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
}

export async function fetchCursorRateLimits(options?: {
  signal?: AbortSignal
  authReadResult?: CursorAuthReadResult
}): Promise<ProviderRateLimits> {
  const auth = options?.authReadResult ?? readCursorAuthSession()
  if (auth.status === 'missing') {
    return result('unavailable', 'Not signed in to Cursor — sign in with Cursor or cursor-agent')
  }
  if (auth.status === 'error') {
    return result('error', auth.error)
  }

  const session = auth.session
  const cookie = cursorUsageSummaryCookie(session.accessToken)
  if (!cookie) {
    return result('error', 'Cursor sign-in is missing a usable account id')
  }

  try {
    const summaryResponse = await fetchJson(
      USAGE_SUMMARY_URL,
      { Cookie: cookie, Accept: 'application/json' },
      { signal: options?.signal }
    )
    if (summaryResponse.status === 401 || summaryResponse.status === 403) {
      return result(
        'error',
        `Cursor usage request unauthorized (HTTP ${summaryResponse.status}) — sign in with Cursor or cursor-agent on the computer running Orca`,
        usageMetadata(session, session.membershipType, {
          failureKind: 'delegated-refresh-required'
        })
      )
    }
    if (summaryResponse.status < 200 || summaryResponse.status >= 300) {
      return result(
        'error',
        `Cursor usage request failed (HTTP ${summaryResponse.status})`,
        usageMetadata(session, session.membershipType, { failureKind: 'server' })
      )
    }

    const mapped = mapCursorUsageSummary(record(summaryResponse.data) as CursorUsageSummary)
    const planType = session.membershipType ?? mapped.planType
    const buckets = [...mapped.buckets]
    try {
      const sandResponse = await fetchJson(
        SAND_USAGE_URL,
        {
          Authorization: `Bearer ${session.accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json'
        },
        { method: 'POST', body: '{}', signal: options?.signal }
      )
      if (sandResponse.status >= 200 && sandResponse.status < 300) {
        const sand = mapCursorSandUsage(record(sandResponse.data) as CursorSandUsage)
        if (sand) {
          buckets.push(sand)
        }
      }
    } catch {
      // Why: the separate Grok Bot RPC must not hide successful billing pools.
    }

    if (buckets.length === 0) {
      return result(
        'unavailable',
        'Cursor usage response did not include quota windows',
        usageMetadata(session, planType, { failureKind: 'usage-unavailable' })
      )
    }
    return result('ok', null, usageMetadata(session, planType), { buckets, planType })
  } catch {
    return result(
      'error',
      'Cursor usage request failed',
      usageMetadata(session, session.membershipType, { failureKind: 'network' })
    )
  }
}
