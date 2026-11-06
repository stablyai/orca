import { readFile } from 'node:fs/promises'
import { join, win32 as pathWin32 } from 'node:path'
import { getMainHttpClient } from '../network/http-client'
import type {
  ProviderRateLimits,
  RateLimitWindow,
  UsageRateLimitMetadata
} from '../../shared/rate-limit-types'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getHostKimiHome, type KimiHomeResolution } from '../kimi/kimi-runtime-home'
import { resolveKimiCodeRuntimeAuth } from '../kimi/kimi-code-runtime-auth'
import {
  createAuthFilesystemOperation,
  type SharedAuthFilesystemOperation
} from './auth-filesystem-operation'
import { classifyThrownUsageRequestError } from './usage-request-failure-kind'

const API_TIMEOUT_MS = 10_000
const CREDENTIALS_READ_TIMEOUT_MS = 5_000

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10080

function kimiHomePath(kimiHome: string, ...segments: string[]): string {
  // WSL homes arrive as `\\wsl.localhost\<distro>\...`, which only win32 join keeps intact.
  return parseWslUncPath(kimiHome)
    ? pathWin32.join(kimiHome, ...segments)
    : join(kimiHome, ...segments)
}

type KimiCredentials = {
  access_token?: string
  expires_at?: number
}

type TextReadResult =
  | { status: 'missing' }
  | { status: 'error'; error: string }
  | { status: 'ok'; raw: string }

type CredentialsReadResult =
  | Exclude<TextReadResult, { status: 'ok' }>
  | { status: 'ok'; credentials: KimiCredentials; usageUrl: string }

function parseCredentials(value: unknown): KimiCredentials | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const credentials: KimiCredentials = {}
  if ('access_token' in value && typeof value.access_token === 'string') {
    credentials.access_token = value.access_token
  }
  if ('expires_at' in value && typeof value.expires_at === 'number') {
    credentials.expires_at = value.expires_at
  }
  return credentials
}

const textReadByPath = new Map<string, SharedAuthFilesystemOperation<TextReadResult>>()

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

function readErrorMessage(err: unknown): string {
  // Timeout rejection may expose message without an Error prototype.
  const message = (err as { message?: unknown } | null)?.message
  return typeof message === 'string' ? message : 'Unable to read Kimi credentials'
}

function getTextRead(path: string): SharedAuthFilesystemOperation<TextReadResult> {
  const existing = textReadByPath.get(path)
  if (existing) {
    return existing
  }
  // Share UNC reads until native settlement; aborting a waiter does not cancel issued I/O.
  const read = createAuthFilesystemOperation(path, async (): Promise<TextReadResult> => {
    try {
      return { status: 'ok', raw: await readFile(path, 'utf-8') }
    } catch (err) {
      return isMissingPathError(err)
        ? { status: 'missing' }
        : { status: 'error', error: readErrorMessage(err) }
    }
  })
  textReadByPath.set(path, read)
  const clearRead = (): void => {
    if (textReadByPath.get(path) === read) {
      textReadByPath.delete(path)
    }
  }
  void read.result.then(clearRead, clearRead)
  return read
}

async function readCredentials(kimiHome: string): Promise<CredentialsReadResult> {
  // Bound both stopped-distro UNC reads so one WSL account cannot stall the poll cycle.
  const signal = AbortSignal.timeout(CREDENTIALS_READ_TIMEOUT_MS)
  try {
    const config = await getTextRead(kimiHomePath(kimiHome, 'config.toml')).wait(signal)
    const auth = resolveKimiCodeRuntimeAuth(config.status === 'ok' ? config.raw : '')
    const credentialsPath = kimiHomePath(kimiHome, 'credentials', `${auth.tokenName}.json`)
    const file = await getTextRead(credentialsPath).wait(signal)
    if (file.status !== 'ok') {
      return file
    }
    const credentials = parseCredentials(JSON.parse(file.raw))
    return credentials
      ? { status: 'ok', credentials, usageUrl: auth.usageUrl }
      : { status: 'error', error: 'Kimi credentials file is invalid' }
  } catch (err) {
    return { status: 'error', error: readErrorMessage(err) }
  }
}

function isAccessTokenFresh(creds: KimiCredentials): boolean {
  return (
    typeof creds.access_token === 'string' &&
    creds.access_token.length > 0 &&
    typeof creds.expires_at === 'number' &&
    // Leave expiry skew for requests in flight; the CLI refreshes on next use.
    creds.expires_at - Math.floor(Date.now() / 1000) > 5
  )
}

type KimiUsageDetail = {
  limit?: string | number
  remaining?: string | number
  used?: string | number
  resetTime?: string
  resetAt?: string
}

type KimiUsageWindow = {
  duration?: number
  timeUnit?: string
}

type KimiUsageLimit = {
  window?: KimiUsageWindow
  detail?: KimiUsageDetail
}

type KimiUsageResponse = {
  usage?: KimiUsageDetail
  limits?: KimiUsageLimit[]
}

function toInt(value: string | number | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function windowToMinutes(window: KimiUsageWindow | undefined): number | null {
  const duration = toInt(window?.duration)
  if (duration === null) {
    return null
  }
  const unit = (window?.timeUnit ?? '').toUpperCase()
  if (unit.includes('MINUTE')) {
    return duration
  }
  if (unit.includes('HOUR')) {
    return duration * 60
  }
  if (unit.includes('DAY')) {
    return duration * 60 * 24
  }
  if (unit.includes('SECOND')) {
    return Math.round(duration / 60)
  }
  return duration
}

function parseResetDescription(isoString: string | undefined): string | null {
  if (!isoString) {
    return null
  }
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function mapWindow(
  detail: KimiUsageDetail | undefined,
  windowMinutes: number
): RateLimitWindow | null {
  if (!detail) {
    return null
  }
  const limit = toInt(detail.limit)
  let used = toInt(detail.used)
  if (used === null) {
    const remaining = toInt(detail.remaining)
    if (remaining !== null && limit !== null) {
      used = limit - remaining
    }
  }
  if (limit === null || limit <= 0 || used === null) {
    return null
  }
  const reset = detail.resetTime ?? detail.resetAt
  return {
    usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
    windowMinutes,
    resetsAt: reset ? new Date(reset).getTime() || null : null,
    resetDescription: parseResetDescription(reset)
  }
}

function mapUsageResponse(data: KimiUsageResponse): ProviderRateLimits {
  // Top-level usage is weekly; limits carries shorter rolling windows, including the 5h session.
  const weekly = mapWindow(data.usage, WEEKLY_WINDOW_MINUTES)
  let session: RateLimitWindow | null = null
  for (const limit of data.limits ?? []) {
    const minutes = windowToMinutes(limit.window) ?? SESSION_WINDOW_MINUTES
    const mapped = mapWindow(limit.detail, minutes)
    if (!mapped) {
      continue
    }
    // Prefer the window closest to a 5h session; otherwise keep the first seen.
    if (
      session === null ||
      Math.abs(minutes - SESSION_WINDOW_MINUTES) <
        Math.abs(session.windowMinutes - SESSION_WINDOW_MINUTES)
    ) {
      session = mapped
    }
  }
  return {
    provider: 'kimi',
    session,
    weekly,
    updatedAt: Date.now(),
    error: session || weekly ? null : 'Kimi usage response did not include quota windows',
    status: session || weekly ? 'ok' : 'error'
  }
}

// A bare "operation was aborted due to timeout" hides which machine stalled.
function readErrorContext(home: KimiHomeResolution, error: string): string {
  return home.runtime === 'wsl' ? `${error} (WSL ${home.wslDistro ?? 'default distro'})` : error
}

function expiredSessionMessage(home: KimiHomeResolution): string {
  const where =
    home.runtime === 'wsl'
      ? `inside WSL (${home.wslDistro ?? 'default distro'})`
      : 'on the computer running Orca'
  return `Kimi session expired — run kimi ${where}, then retry usage.`
}

function result(
  status: ProviderRateLimits['status'],
  error: string | null,
  usageMetadata?: UsageRateLimitMetadata
): ProviderRateLimits {
  return {
    provider: 'kimi',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

/** Read usage from host/WSL credentials selected by home (#12370); config chooses credential slot and usage URL.
 * The CLI owns rotating refresh tokens: never refresh/write its file or invalidate a live session.
 * Use GET /usages, never the completion endpoint. */
export async function fetchKimiRateLimits(options?: {
  home?: KimiHomeResolution
}): Promise<ProviderRateLimits> {
  const home: KimiHomeResolution = options?.home ?? {
    runtime: 'host',
    wslDistro: null,
    path: getHostKimiHome()
  }
  if (home.path === null) {
    return result('error', `WSL Kimi home unavailable for ${home.wslDistro ?? 'default distro'}`)
  }
  const readResult = await readCredentials(home.path)
  if (readResult.status === 'missing') {
    return result('unavailable', 'Not signed in to Kimi Code')
  }
  if (readResult.status === 'error') {
    return result('error', readErrorContext(home, readResult.error))
  }
  const creds = readResult.credentials
  if (typeof creds.access_token !== 'string' || creds.access_token.length === 0) {
    return result('error', 'Kimi credentials file is missing an access token')
  }
  if (!isAccessTokenFresh(creds)) {
    // Let Kimi refresh on next use; transient error preserves the last good usage snapshot.
    return result('error', expiredSessionMessage(home), {
      failureKind: 'delegated-refresh-required',
      source: 'oauth'
    })
  }

  try {
    const res = await getMainHttpClient().fetch(readResult.usageUrl, {
      // Match CLI fetchManagedUsage headers; this token-authenticated endpoint needs no custom User-Agent.
      headers: { Authorization: `Bearer ${creds.access_token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403) {
      return result('error', `Kimi usage request unauthorized (HTTP ${res.status})`)
    }
    if (!res.ok) {
      return result('error', `Kimi usage request failed (HTTP ${res.status})`)
    }
    const data: unknown = await res.json()
    return mapUsageResponse(typeof data === 'object' && data !== null ? data : {})
  } catch (err) {
    return result('error', err instanceof Error ? err.message : 'Kimi usage request failed', {
      failureKind: classifyThrownUsageRequestError(err)
    })
  }
}
