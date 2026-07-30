import { unlinkSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { request } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IPty } from 'node-pty'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { resolveCliCommand } from '../codex-cli/command'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const STARTUP_TIMEOUT_MS = 12_000
const REQUEST_TIMEOUT_MS = 2_000
const POLL_INTERVAL_MS = 200
const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const HTTPS_PORT_RE = /listening on random port at (\d+) for HTTPS/i

type AntigravityBucket = {
  window: string
  remainingFraction: number
  resetTime: string
}

function isBucket(value: unknown): value is AntigravityBucket {
  if (!value || typeof value !== 'object') {
    return false
  }
  const bucket = value as Partial<AntigravityBucket>
  return (
    typeof bucket.window === 'string' &&
    typeof bucket.remainingFraction === 'number' &&
    Number.isFinite(bucket.remainingFraction) &&
    typeof bucket.resetTime === 'string'
  )
}

function toWindow(bucket: AntigravityBucket, windowMinutes: number): RateLimitWindow {
  const resetsAt = new Date(bucket.resetTime).getTime()
  return {
    usedPercent: Math.min(100, Math.max(0, Math.round((1 - bucket.remainingFraction) * 100))),
    windowMinutes,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    resetDescription: null
  }
}

export function parseAntigravityGeminiQuota(data: unknown): {
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
} | null {
  if (!data || typeof data !== 'object' || !('response' in data)) {
    return null
  }
  const response = data.response
  if (!response || typeof response !== 'object' || !('groups' in response)) {
    return null
  }
  if (!Array.isArray(response.groups)) {
    return null
  }
  const geminiGroup = response.groups.find((group) => {
    return (
      group &&
      typeof group === 'object' &&
      'displayName' in group &&
      typeof group.displayName === 'string' &&
      /gemini/i.test(group.displayName)
    )
  })
  if (!geminiGroup || typeof geminiGroup !== 'object' || !('buckets' in geminiGroup)) {
    return null
  }
  const buckets = Array.isArray(geminiGroup.buckets)
    ? geminiGroup.buckets.filter((bucket) => isBucket(bucket))
    : []
  const sessionBucket = buckets.find((bucket) => bucket.window === '5h')
  const weeklyBucket = buckets.find((bucket) => bucket.window === 'weekly')
  if (!sessionBucket && !weeklyBucket) {
    return null
  }
  return {
    session: sessionBucket ? toWindow(sessionBucket, 300) : null,
    weekly: weeklyBucket ? toWindow(weeklyBucket, 10_080) : null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForHttpsPort(logPath: string, deadline: number): Promise<number> {
  while (Date.now() < deadline) {
    const log = await readFile(logPath, 'utf8').catch(() => '')
    const match = HTTPS_PORT_RE.exec(log)
    if (match) {
      return Number.parseInt(match[1], 10)
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error('Antigravity local API did not start')
}

function requestQuota(port: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: QUOTA_PATH,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'connect-protocol-version': '1'
        },
        // Why: agy creates an ephemeral self-signed certificate for this exact
        // loopback-only endpoint; no external host is contacted through it.
        rejectUnauthorized: false
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Antigravity quota request failed (${response.statusCode ?? 0})`))
            return
          }
          try {
            resolve(JSON.parse(body) as unknown)
          } catch {
            reject(new Error('Antigravity quota response was not valid JSON'))
          }
        })
      }
    )
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Antigravity quota request timed out'))
    })
    req.on('error', reject)
    req.end('{}')
  })
}

async function waitForQuota(
  port: number,
  deadline: number
): Promise<{
  session: RateLimitWindow | null
  weekly: RateLimitWindow | null
}> {
  let lastError: Error | null = null
  while (Date.now() < deadline) {
    try {
      const parsed = parseAntigravityGeminiQuota(await requestQuota(port))
      if (parsed) {
        return parsed
      }
      lastError = new Error('Antigravity Gemini quota is unavailable')
    } catch (error) {
      lastError = error instanceof Error ? error : new Error('Antigravity quota request failed')
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw lastError ?? new Error('Antigravity Gemini quota is unavailable')
}

export async function fetchGeminiRateLimitsViaAntigravity(): Promise<ProviderRateLimits> {
  const logPath = join(
    tmpdir(),
    `orca-antigravity-quota-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`
  )
  let term: IPty | null = null
  const disposables: { dispose: () => void }[] = []
  try {
    const pty = await import('node-pty')
    const command = resolveCliCommand('agy')
    const isWin32 = process.platform === 'win32'
    const spawnFile = isWin32 ? 'cmd.exe' : command
    const spawnArgs = isWin32
      ? ['/d', '/s', '/c', `"${command}" --log-file "${logPath}"`]
      : ['--log-file', logPath]
    term = pty.spawn(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: resolveHiddenRateLimitPtyCwd(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
    disposables.push(registerHiddenRateLimitPty(term))
    const deadline = Date.now() + STARTUP_TIMEOUT_MS
    const port = await waitForHttpsPort(logPath, deadline)
    const quota = await waitForQuota(port, deadline)
    return {
      provider: 'gemini',
      ...quota,
      updatedAt: Date.now(),
      error: null,
      status: 'ok',
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        credentialSource: 'Antigravity keyring',
        authProvenance: 'antigravity-local-rpc'
      }
    }
  } catch (error) {
    return {
      provider: 'gemini',
      session: null,
      weekly: null,
      updatedAt: Date.now(),
      error: error instanceof Error ? error.message : 'Antigravity quota request failed',
      status: 'unavailable',
      usageMetadata: {
        source: 'cli',
        attemptedSources: ['cli'],
        failureKind: 'usage-unavailable',
        authProvenance: 'antigravity-local-rpc'
      }
    }
  } finally {
    if (term) {
      cleanupHiddenRateLimitPty(term, disposables, { kill: true })
    }
    try {
      unlinkSync(logPath)
    } catch {
      /* agy may exit before creating its requested log file */
    }
  }
}
