import { readdir, readFile, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'

const LOG_DIR = join(homedir(), '.gemini', 'antigravity-cli', 'log')
// Why: the server logs an HTTPS and an HTTP port; the HTTP one needs no certificate and no CSRF token.
const PORT_LINE = /listening on random port at (\d+) for HTTP(?!S)/g
const RPC_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const TIMEOUT_MS = 10_000
const WINDOW_MINUTES: Record<string, number> = { '5h': 300, weekly: 10080 }
const NOT_RUNNING_REASON =
  'Antigravity usage is not available. Orca reads it from the Antigravity language server, which is only reachable while Antigravity is running.'
const UNREADABLE_REASON =
  'Antigravity usage is not available. The Antigravity language server answered without any readable quota.'

type QuotaSummaryResponse = {
  response?: {
    groups?: {
      displayName?: string
      buckets?: { window?: string; remainingFraction?: number; resetTime?: string }[]
    }[]
  }
}

function unusableResult(status: 'unavailable' | 'error', error: string): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

/** A server that answered is never reported as "not running". */
export function quotaRateLimitsFromResponse(statusCode: number, body: string): ProviderRateLimits {
  if (statusCode !== 200) {
    return unusableResult('error', UNREADABLE_REASON)
  }
  const buckets: RateLimitBucket[] = []
  try {
    const data = JSON.parse(body) as QuotaSummaryResponse
    for (const group of data.response?.groups ?? []) {
      // Why: group names read "Gemini Models" / "Claude and GPT models"; the suffix is noise in a status bar.
      const pool = (group.displayName ?? '').replace(/\s*models$/i, '')
      for (const bucket of group.buckets ?? []) {
        const windowMinutes = WINDOW_MINUTES[bucket.window ?? '']
        if (!windowMinutes || typeof bucket.remainingFraction !== 'number') {
          continue
        }
        const resetsAt = bucket.resetTime ? new Date(bucket.resetTime).getTime() : Number.NaN
        buckets.push({
          name: `${pool} ${bucket.window === 'weekly' ? 'Weekly' : '5h'}`.trim(),
          usedPercent: Math.min(100, Math.max(0, Math.round((1 - bucket.remainingFraction) * 100))),
          windowMinutes,
          resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
          resetDescription: null
        })
      }
    }
  } catch {
    return unusableResult('error', UNREADABLE_REASON)
  }
  if (buckets.length === 0) {
    return unusableResult('error', UNREADABLE_REASON)
  }
  // Why: the pools are independent, so the headline window is the tightest one the user can hit.
  const tightest = (windowMinutes: number): RateLimitWindow | null => {
    const scoped = buckets.filter((bucket) => bucket.windowMinutes === windowMinutes)
    if (scoped.length === 0) {
      return null
    }
    const { name: _name, ...window } = scoped.reduce((worst, bucket) =>
      bucket.usedPercent > worst.usedPercent ? bucket : worst
    )
    return window
  }
  return {
    provider: 'antigravity',
    session: tightest(300),
    weekly: tightest(10080),
    buckets,
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

async function readLanguageServerPort(): Promise<number | null> {
  const entries = await readdir(LOG_DIR).catch(() => [] as string[])
  const logs = await Promise.all(
    entries
      .filter((name) => name.endsWith('.log'))
      .map(async (name) => ({
        name,
        // Why: the port is random per launch, so the live server owns the log still being written to.
        mtimeMs: await stat(join(LOG_DIR, name))
          .then((stats) => stats.mtimeMs)
          .catch(() => 0)
      }))
  )
  const newest = logs.sort((a, b) => b.mtimeMs - a.mtimeMs).at(0)
  if (!newest) {
    return null
  }
  const text = await readFile(join(LOG_DIR, newest.name), 'utf8').catch(() => '')
  const ports = [...text.matchAll(PORT_LINE)]
  return ports.length > 0 ? Number(ports.at(-1)![1]) : null
}

export async function fetchAntigravityRateLimits(options?: {
  signal?: AbortSignal
}): Promise<ProviderRateLimits> {
  const port = await readLanguageServerPort()
  if (!port) {
    return unusableResult('unavailable', NOT_RUNNING_REASON)
  }
  try {
    return await new Promise<ProviderRateLimits>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: RPC_PATH,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // Why: node:http rather than electron's net.fetch, so a configured proxy cannot intercept loopback.
          timeout: TIMEOUT_MS,
          signal: options?.signal
        },
        (res) => {
          let chunks = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => (chunks += chunk))
          res.on('end', () => resolve(quotaRateLimitsFromResponse(res.statusCode ?? 0, chunks)))
        }
      )
      req.on('timeout', () => req.destroy(new Error('Timed out')))
      req.on('error', reject)
      req.end('{}')
    })
  } catch {
    return unusableResult('unavailable', NOT_RUNNING_REASON)
  }
}
