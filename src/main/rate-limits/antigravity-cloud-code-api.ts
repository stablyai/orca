/**
 * Two-step Cloud Code call that returns Antigravity's own quota pools.
 *
 * `loadCodeAssist` resolves the project the quota is billed against, and
 * `retrieveUserQuotaSummary` returns the grouped windows Antigravity shows in its
 * own usage panel. Both are undocumented `v1internal` endpoints.
 */

import { net } from 'electron'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'

const API_TIMEOUT_MS = 10_000

// Why: cloudcode-pa selects the product from the User-Agent, not from the request body. With a
// UA that does not contain "antigravity" the call still answers 200 but omits
// cloudaicompanionProject, and the quota step then fails 403 — indistinguishable from a bad
// sign-in. Electron's default Chromium UA resolves to a different product with no quota grant.
const USER_AGENT = 'orca-antigravity-usage/1.0'

// Why: Antigravity ships against the "daily" host; stable builds answer on the plain one.
const API_HOSTS = ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com'] as const

export type AntigravityQuotaBucket = {
  displayName: string
  window: string
  resetTime: string
  remainingFraction: number
  description?: string
}

export type AntigravityQuotaGroup = {
  displayName: string
  buckets: AntigravityQuotaBucket[]
}

export type AntigravityQuotaFetch =
  | { status: 'ok'; groups: AntigravityQuotaGroup[] }
  /** The credential authenticated but carries no Antigravity entitlement. */
  | { status: 'not-entitled' }
  | { status: 'unauthorized' }
  | { status: 'error'; message: string }

function isBucket(value: unknown): value is AntigravityQuotaBucket {
  const b = value as AntigravityQuotaBucket
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof b.displayName === 'string' &&
    typeof b.window === 'string' &&
    typeof b.resetTime === 'string' &&
    typeof b.remainingFraction === 'number' &&
    Number.isFinite(b.remainingFraction)
  )
}

function parseGroups(data: unknown): AntigravityQuotaGroup[] {
  const raw = (data as { groups?: unknown })?.groups
  if (!Array.isArray(raw)) {
    return []
  }
  return raw.flatMap((entry) => {
    const group = entry as { displayName?: unknown; buckets?: unknown }
    if (typeof group.displayName !== 'string' || !Array.isArray(group.buckets)) {
      return []
    }
    return [{ displayName: group.displayName, buckets: group.buckets.filter(isBucket) }]
  })
}

async function postInternal(
  host: string,
  method: string,
  accessToken: string,
  body: unknown,
  signal: AbortSignal
): Promise<{ ok: true; data: unknown } | { ok: false; status: number }> {
  const res = await net.fetch(`https://${host}/v1internal:${method}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': USER_AGENT
    },
    body: JSON.stringify(body),
    signal
  })
  if (!res.ok) {
    await cancelUnreadResponseBody(res)
    return { ok: false, status: res.status }
  }
  return { ok: true, data: (await res.json()) as unknown }
}

function hostFailureMessage(host: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : 'request failed'
  return `Antigravity quota request to ${host} failed: ${reason}`
}

async function fetchFromHost(
  host: string,
  accessToken: string,
  signal: AbortSignal
): Promise<AntigravityQuotaFetch> {
  const loaded = await postInternal(
    host,
    'loadCodeAssist',
    accessToken,
    { metadata: { ideType: 'ANTIGRAVITY' } },
    signal
  )
  if (!loaded.ok) {
    return loaded.status === 401
      ? { status: 'unauthorized' }
      : { status: 'error', message: `Antigravity project lookup failed (HTTP ${loaded.status})` }
  }
  const project = (loaded.data as { cloudaicompanionProject?: unknown }).cloudaicompanionProject
  if (typeof project !== 'string' || project.length === 0) {
    return { status: 'not-entitled' }
  }
  const quota = await postInternal(
    host,
    'retrieveUserQuotaSummary',
    accessToken,
    { project },
    signal
  )
  if (!quota.ok) {
    if (quota.status === 401) {
      return { status: 'unauthorized' }
    }
    return quota.status === 403
      ? { status: 'not-entitled' }
      : { status: 'error', message: `Antigravity quota fetch failed (HTTP ${quota.status})` }
  }
  return { status: 'ok', groups: parseGroups(quota.data) }
}

export async function fetchAntigravityQuota(
  accessToken: string,
  callerSignal?: AbortSignal
): Promise<AntigravityQuotaFetch> {
  let last: AntigravityQuotaFetch = { status: 'error', message: 'No Cloud Code host answered' }
  for (const host of API_HOSTS) {
    if (callerSignal?.aborted) {
      return last
    }
    // Why: one deadline shared across hosts lets a slow first host spend the budget the
    // fallback needs, so the second attempt starts already aborted.
    const timeout = AbortSignal.timeout(API_TIMEOUT_MS)
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout
    try {
      last = await fetchFromHost(host, accessToken, signal)
    } catch (error) {
      // Why: a rejected request is this host's verdict, not the account's — the next host still gets a turn.
      last = { status: 'error', message: hostFailureMessage(host, error) }
    }
    // Why: an auth or entitlement verdict is the account's, not the host's — retrying decides nothing.
    if (last.status !== 'error') {
      return last
    }
  }
  return last
}
