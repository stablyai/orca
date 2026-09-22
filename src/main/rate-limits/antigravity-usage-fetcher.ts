import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import {
  ANTIGRAVITY_LOOPBACK_HOST,
  postAntigravityLoopbackQuota
} from './antigravity-loopback-quota'

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'

export const ANTIGRAVITY_USAGE_UNAVAILABLE =
  'Antigravity usage is not available. Start agy so Orca can read its quota.'
export const ANTIGRAVITY_USAGE_PROBE_FAILED =
  'Antigravity usage is not available. The local Agy LanguageServer did not return quota.'

export type AntigravityLanguageServerEndpoint = {
  pid: number
  httpPort: number | null
  httpsPort: number | null
}

export type AntigravityUsageFetchDeps = {
  endpoint?: AntigravityLanguageServerEndpoint | null
  homedir?: () => string
  postQuota?: (url: string) => Promise<unknown>
  now?: () => number
  requestTimeoutMs?: number
  maxResponseBytes?: number
}

type CadenceWindow = RateLimitWindow & { cadence: 'session' | 'weekly' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function failedLimits(
  now: number,
  error: string,
  status: 'unavailable' | 'error',
  failureKind: 'cli-unavailable' | 'network'
): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error,
    status,
    usageMetadata: { source: 'cli', failureKind }
  }
}

export function parseAntigravityLanguageServerLog(
  logHead: string
): AntigravityLanguageServerEndpoint | null {
  const pid = Number(/Starting language server process with pid (\d+)/.exec(logHead)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  let httpPort: number | null = null
  let httpsPort: number | null = null
  const portPattern = /listening on random port at (\d+) for (HTTPS|HTTP)\b/g
  for (const match of logHead.matchAll(portPattern)) {
    const port = Number(match[1])
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      continue
    }
    if (match[2] === 'HTTP') {
      httpPort ??= port
    } else {
      httpsPort ??= port
    }
  }
  if (httpPort === null && httpsPort === null) {
    return null
  }
  return { pid, httpPort, httpsPort }
}

function windowFromBucket(raw: unknown): CadenceWindow | null {
  if (!isRecord(raw) || raw.disabled === true) {
    return null
  }
  const remaining = raw.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    return null
  }
  const id = typeof raw.bucketId === 'string' ? raw.bucketId : ''
  const name = typeof raw.displayName === 'string' ? raw.displayName : id
  const text = `${id} ${name}`.toLowerCase()
  const cadence: CadenceWindow['cadence'] | null = /weekly|7d|7-day/.test(text)
    ? 'weekly'
    : /5h|five[- ]hour/.test(text)
      ? 'session'
      : null
  if (!cadence) {
    return null
  }
  const resetTime = typeof raw.resetTime === 'string' ? Date.parse(raw.resetTime) : Number.NaN
  return {
    cadence,
    usedPercent: Math.min(100, Math.max(0, Math.round((1 - remaining) * 100))),
    windowMinutes: cadence === 'weekly' ? 10_080 : 300,
    resetsAt: Number.isNaN(resetTime) ? null : resetTime,
    resetDescription: null
  }
}

function tightest(
  windows: CadenceWindow[],
  cadence: CadenceWindow['cadence']
): RateLimitWindow | null {
  let chosen: CadenceWindow | null = null
  for (const window of windows) {
    if (window.cadence === cadence && (!chosen || window.usedPercent > chosen.usedPercent)) {
      chosen = window
    }
  }
  return chosen
    ? {
        usedPercent: chosen.usedPercent,
        windowMinutes: chosen.windowMinutes,
        resetsAt: chosen.resetsAt,
        resetDescription: chosen.resetDescription
      }
    : null
}

export function mapAntigravityQuotaSummary(data: unknown): ProviderRateLimits | null {
  if (!isRecord(data)) {
    return null
  }
  const response = isRecord(data.response) ? data.response : null
  const groups = Array.isArray(response?.groups) ? response.groups : null
  if (!groups) {
    return null
  }
  const windows: CadenceWindow[] = []
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      continue
    }
    for (const raw of group.buckets) {
      const window = windowFromBucket(raw)
      if (window) {
        windows.push(window)
      }
    }
  }
  const session = tightest(windows, 'session')
  const weekly = tightest(windows, 'weekly')
  if (!session && !weekly) {
    return null
  }
  return {
    provider: 'antigravity',
    session,
    weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', lastSuccessfulSource: 'cli' }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

function discoverCurrentEndpoint(
  resolveHome: () => string = homedir
): AntigravityLanguageServerEndpoint | null {
  const logDir = path.join(resolveHome(), '.gemini', 'antigravity-cli', 'log')
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return null
  }
  // Why: recency is only search order; a live LanguageServer can outlive newer exited logs.
  names = names
    .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
    .sort()
    .toReversed()
  for (const name of names) {
    try {
      const fd = openSync(path.join(logDir, name), 'r')
      try {
        const buffer = Buffer.alloc(8_192)
        const bytesRead = readSync(fd, buffer, 0, 8_192, 0)
        const endpoint = parseAntigravityLanguageServerLog(
          buffer.subarray(0, bytesRead).toString('utf8')
        )
        if (endpoint && isProcessAlive(endpoint.pid)) {
          return endpoint
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      continue
    }
  }
  return null
}

async function probeQuota(
  endpoint: AntigravityLanguageServerEndpoint,
  postQuota: (url: string) => Promise<unknown>,
  now: () => number
): Promise<ProviderRateLimits> {
  const urls = [
    ...(endpoint.httpPort === null
      ? []
      : [`http://${ANTIGRAVITY_LOOPBACK_HOST}:${endpoint.httpPort}${QUOTA_PATH}`]),
    ...(endpoint.httpsPort === null
      ? []
      : [`https://${ANTIGRAVITY_LOOPBACK_HOST}:${endpoint.httpsPort}${QUOTA_PATH}`])
  ]
  for (const url of urls) {
    try {
      const mapped = mapAntigravityQuotaSummary(await postQuota(url))
      if (mapped) {
        return mapped
      }
    } catch {
      continue
    }
  }
  return failedLimits(now(), ANTIGRAVITY_USAGE_PROBE_FAILED, 'error', 'network')
}

export function fetchAntigravityRateLimits(
  deps: AntigravityUsageFetchDeps = {}
): Promise<ProviderRateLimits> {
  const now = deps.now ?? Date.now
  const endpoint =
    deps.endpoint !== undefined ? deps.endpoint : discoverCurrentEndpoint(deps.homedir)
  if (!endpoint) {
    return Promise.resolve(
      failedLimits(now(), ANTIGRAVITY_USAGE_UNAVAILABLE, 'unavailable', 'cli-unavailable')
    )
  }
  return probeQuota(
    endpoint,
    deps.postQuota ??
      ((url) => postAntigravityLoopbackQuota(url, deps.requestTimeoutMs, deps.maxResponseBytes)),
    now
  )
}
