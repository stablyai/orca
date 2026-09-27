import * as https from 'node:https'
import type { ProviderRateLimits, RateLimitBucket } from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_GEMINI_FIVE_HOUR_BUCKET_NAME,
  ANTIGRAVITY_GEMINI_WEEKLY_BUCKET_NAME,
  ANTIGRAVITY_THIRD_PARTY_FIVE_HOUR_BUCKET_NAME,
  ANTIGRAVITY_THIRD_PARTY_WEEKLY_BUCKET_NAME
} from '../../shared/antigravity-usage-buckets'
import { discoverAntigravityRuntime } from './antigravity-process-discovery'

// Why: this is the same RPC the Antigravity IDE's own "Settings > Models &
// Usage" panel calls on its local runtime — not Gemini CLI's `retrieveUserQuota`,
// which only ever describes shared Google Code Assist quota (see #9122/#19561:
// Orca previously republished a Gemini CLI read under the Antigravity provider).
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const REQUEST_TIMEOUT_MS = 3_000
const FIVE_HOUR_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

type RawQuotaBucket = {
  bucketId?: unknown
  displayName?: unknown
  window?: unknown
  remainingFraction?: unknown
  resetTime?: unknown
}

type RawQuotaGroup = {
  displayName?: unknown
  buckets?: unknown
}

type RawQuotaSummaryResponse = {
  response?: {
    groups?: unknown
  }
}

function postConnectRpc(port: number, csrfToken: string, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from('{}', 'utf-8')
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        // Why: the local runtime terminates TLS with a fresh, per-launch
        // self-signed certificate on loopback only. The CSRF token in the
        // header (not the certificate) is what proves the caller is allowed
        // to talk to it — the same trust model Antigravity's own webview
        // clients use to reach this port.
        rejectUnauthorized: false,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
          'Connect-Protocol-Version': '1',
          'X-Codeium-Csrf-Token': csrfToken
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(
              new Error(`Antigravity quota request failed (HTTP ${res.statusCode ?? 'unknown'})`)
            )
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown)
          } catch {
            reject(new Error('Antigravity quota response was not valid JSON'))
          }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('Antigravity quota request timed out'))
    })
    req.write(payload)
    req.end()
  })
}

function classifyGroup(displayName: unknown): 'gemini' | 'third-party' | null {
  if (typeof displayName !== 'string' || displayName.trim().length === 0) {
    return null
  }
  return /gemini/i.test(displayName) ? 'gemini' : 'third-party'
}

// Why: `bucketId` ("gemini-weekly", "3p-5h") is the most stable signal — it is
// an identifier, not display copy — but displayName/window are checked too so
// a future rename on either side doesn't silently drop a bucket.
function classifyBucketWindow(bucket: RawQuotaBucket): 'weekly' | '5h' | null {
  const bucketId = typeof bucket.bucketId === 'string' ? bucket.bucketId : ''
  const window = typeof bucket.window === 'string' ? bucket.window : ''
  const displayName = typeof bucket.displayName === 'string' ? bucket.displayName : ''
  if (window === 'weekly' || bucketId.endsWith('-weekly') || /weekly/i.test(displayName)) {
    return 'weekly'
  }
  if (window === '5h' || bucketId.endsWith('-5h') || /five.?hour/i.test(displayName)) {
    return '5h'
  }
  return null
}

function bucketNameFor(group: 'gemini' | 'third-party', windowKind: 'weekly' | '5h'): string {
  if (group === 'gemini') {
    return windowKind === 'weekly'
      ? ANTIGRAVITY_GEMINI_WEEKLY_BUCKET_NAME
      : ANTIGRAVITY_GEMINI_FIVE_HOUR_BUCKET_NAME
  }
  return windowKind === 'weekly'
    ? ANTIGRAVITY_THIRD_PARTY_WEEKLY_BUCKET_NAME
    : ANTIGRAVITY_THIRD_PARTY_FIVE_HOUR_BUCKET_NAME
}

function toRateLimitBucket(
  group: 'gemini' | 'third-party',
  windowKind: 'weekly' | '5h',
  bucket: RawQuotaBucket
): RateLimitBucket | null {
  const remainingFraction = bucket.remainingFraction
  if (typeof remainingFraction !== 'number' || !Number.isFinite(remainingFraction)) {
    return null
  }
  const clamped = Math.min(1, Math.max(0, remainingFraction))
  const usedPercent = Math.round((1 - clamped) * 100)
  const resetTime = typeof bucket.resetTime === 'string' ? bucket.resetTime : null
  const resetsAtTime = resetTime ? new Date(resetTime).getTime() : Number.NaN
  return {
    name: bucketNameFor(group, windowKind),
    usedPercent,
    windowMinutes: windowKind === 'weekly' ? WEEKLY_WINDOW_MINUTES : FIVE_HOUR_WINDOW_MINUTES,
    resetsAt: Number.isFinite(resetsAtTime) ? resetsAtTime : null,
    resetDescription: null
  }
}

/**
 * Parses a `RetrieveUserQuotaSummaryResponse` (wrapped in `{ response: ... }`
 * by the local runtime's Connect-RPC envelope) into the four named buckets
 * Orca's usage UI renders. Unrecognized or missing groups/buckets are skipped
 * rather than thrown — a partial, honest reading beats none.
 */
export function parseAntigravityQuotaSummary(data: unknown): RateLimitBucket[] {
  const groupList = (data as RawQuotaSummaryResponse | null | undefined)?.response?.groups
  if (!Array.isArray(groupList)) {
    return []
  }
  const buckets: RateLimitBucket[] = []
  for (const rawGroup of groupList) {
    if (!rawGroup || typeof rawGroup !== 'object') {
      continue
    }
    const group = rawGroup as RawQuotaGroup
    const groupKind = classifyGroup(group.displayName)
    const rawBuckets = group.buckets
    if (!groupKind || !Array.isArray(rawBuckets)) {
      continue
    }
    for (const rawBucket of rawBuckets) {
      if (!rawBucket || typeof rawBucket !== 'object') {
        continue
      }
      const windowKind = classifyBucketWindow(rawBucket as RawQuotaBucket)
      if (!windowKind) {
        continue
      }
      const bucket = toRateLimitBucket(groupKind, windowKind, rawBucket as RawQuotaBucket)
      if (bucket) {
        buckets.push(bucket)
      }
    }
  }
  return buckets
}

async function fetchViaPort(port: number, csrfToken: string): Promise<RateLimitBucket[]> {
  const data = await postConnectRpc(port, csrfToken, RPC_PATH)
  const buckets = parseAntigravityQuotaSummary(data)
  if (buckets.length === 0) {
    throw new Error('Antigravity quota response had no recognizable Gemini/Claude/GPT buckets')
  }
  return buckets
}

/**
 * Fetches Antigravity's own quota from its local runtime (the same
 * `RetrieveUserQuotaSummary` call backing Settings > Models & Usage), fully
 * independent of the Gemini CLI fetcher. Returns `unavailable` when the
 * Antigravity IDE (or its background language_server process) is not running
 * on this machine, and `error` when it is running but the request failed.
 */
export async function fetchAntigravityRateLimits(): Promise<ProviderRateLimits> {
  const runtime = await discoverAntigravityRuntime().catch(() => null)
  if (!runtime) {
    return {
      provider: 'antigravity',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error:
        'Antigravity usage is not available. Open the Antigravity IDE on this computer (its background runtime must be running), then retry.',
      status: 'unavailable',
      usageMetadata: { failureKind: 'cli-unavailable' }
    }
  }

  let lastError: unknown = null
  for (const port of runtime.ports) {
    try {
      const buckets = await fetchViaPort(port, runtime.csrfToken)
      return {
        provider: 'antigravity',
        session: null,
        weekly: null,
        buckets,
        updatedAt: Date.now(),
        error: null,
        status: 'ok'
      }
    } catch (err) {
      lastError = err
    }
  }
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: lastError instanceof Error ? lastError.message : 'Antigravity quota fetch failed',
    status: 'error',
    usageMetadata: { failureKind: 'network' }
  }
}
