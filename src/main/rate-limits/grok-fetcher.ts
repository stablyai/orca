import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { net } from 'electron'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { authenticateWithGrokCli } from './grok-acp-auth'

// Why: Grok CLI's `/usage` command reads this read-only billing route. We use
// the same route after ACP auth refreshes the CLI-owned cached token.
const DEFAULT_GROK_BASE_URL = 'https://cli-chat-proxy.grok.com/v1'
const API_TIMEOUT_MS = 15_000
const WEEKLY_WINDOW_MINUTES = 10080
const TOKEN_EXPIRY_SKEW_MS = 60_000

type GrokAuthRecord = {
  key?: unknown
  expires_at?: unknown
  expiresAt?: unknown
}

type GrokBillingProductUsage = {
  product?: unknown
  usagePercent?: unknown
}

type GrokBillingConfig = {
  creditUsagePercent?: unknown
  currentPeriod?: { end?: unknown }
  productUsage?: GrokBillingProductUsage[]
  billingPeriodEnd?: unknown
}

type GrokBillingPayload = {
  config?: GrokBillingConfig
}

type GrokAccessTokenResult =
  | { status: 'ok'; token: string; expired: boolean }
  | { status: 'missing' | 'error'; error: string }

type GrokBillingFetchResult = {
  rateLimits: ProviderRateLimits
  unauthorized: boolean
}

export type FetchGrokRateLimitsOptions = {
  grokHomePath?: string | null
}

function makeResult(
  status: ProviderRateLimits['status'],
  error: string | null,
  failureKind?: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind']
): ProviderRateLimits {
  return {
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: { source: 'cli', ...(failureKind ? { failureKind } : {}) }
  }
}

function getGrokHome(options: FetchGrokRateLimitsOptions = {}): string {
  return options.grokHomePath?.trim() || process.env.GROK_HOME?.trim() || join(homedir(), '.grok')
}

function getAuthPath(options: FetchGrokRateLimitsOptions = {}): string {
  return join(getGrokHome(options), 'auth.json')
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function parseTokenExpiresAtMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null
  }
  const numeric = Number(value)
  if (Number.isFinite(numeric)) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

function isExpiredToken(record: GrokAuthRecord): boolean {
  const expiresAt = parseTokenExpiresAtMs(record.expires_at ?? record.expiresAt)
  return expiresAt !== null && expiresAt - Date.now() <= TOKEN_EXPIRY_SKEW_MS
}

function readGrokAccessToken(options: FetchGrokRateLimitsOptions = {}): GrokAccessTokenResult {
  const authPath = getAuthPath(options)
  if (!existsSync(authPath)) {
    return { status: 'missing', error: 'Not signed in to Grok. Run `grok login`.' }
  }
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf-8')) as Record<string, unknown>
    let expiredToken: string | null = null
    for (const value of Object.values(parsed)) {
      const record = asObject(value) as GrokAuthRecord | null
      if (typeof record?.key === 'string' && record.key.length > 0) {
        if (isExpiredToken(record)) {
          expiredToken ??= record.key
          continue
        }
        return { status: 'ok', token: record.key, expired: false }
      }
    }
    if (expiredToken) {
      return { status: 'ok', token: expiredToken, expired: true }
    }
    return { status: 'missing', error: 'Grok credentials file is missing an access token.' }
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unable to read Grok credentials.'
    }
  }
}

function parseResetDescription(ms: number | null): string | null {
  if (!ms) {
    return null
  }
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  const isToday = date.toDateString() === new Date().toDateString()
  return isToday
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function parseResetMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null
  }
  const ms = new Date(value).getTime()
  return Number.isFinite(ms) ? ms : null
}

function selectGrokBuildUsage(config: GrokBillingConfig): number | null {
  const productUsage = Array.isArray(config.productUsage) ? config.productUsage : []
  const grokBuild = productUsage.find(
    (entry) => typeof entry?.product === 'string' && entry.product.toLowerCase() === 'grokbuild'
  )
  return asNumber(grokBuild?.usagePercent) ?? asNumber(config.creditUsagePercent)
}

export function mapGrokBillingPayload(
  payload: unknown,
  updatedAt = Date.now()
): ProviderRateLimits {
  const root = asObject(payload) as GrokBillingPayload | null
  const config = root?.config && typeof root.config === 'object' ? root.config : null
  if (!config) {
    return makeResult('error', 'Grok billing response did not include a config object.', 'parse')
  }
  const usedPercent = selectGrokBuildUsage(config)
  if (usedPercent === null) {
    return makeResult('error', 'Grok billing response did not include usage percent.', 'parse')
  }
  const resetMs = parseResetMs(config.currentPeriod?.end) ?? parseResetMs(config.billingPeriodEnd)
  const weekly: RateLimitWindow = {
    usedPercent: clampPercent(usedPercent),
    windowMinutes: WEEKLY_WINDOW_MINUTES,
    resetsAt: resetMs,
    resetDescription: parseResetDescription(resetMs)
  }
  return {
    provider: 'grok',
    session: null,
    weekly,
    updatedAt,
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli' }
  }
}

async function fetchGrokBilling(token: string): Promise<GrokBillingFetchResult> {
  const baseUrl = (process.env.GROK_CLI_CHAT_PROXY_BASE_URL ?? DEFAULT_GROK_BASE_URL).replace(
    /\/$/,
    ''
  )
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json'
  }
  try {
    const response = await net.fetch(`${baseUrl}/billing?format=credits`, {
      headers,
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    if (response.status === 401 || response.status === 403) {
      return {
        rateLimits: makeResult(
          'error',
          `Grok billing request unauthorized (HTTP ${response.status}).`,
          'stale-token'
        ),
        unauthorized: true
      }
    }
    if (!response.ok) {
      return {
        rateLimits: makeResult(
          'error',
          `Grok billing request failed (HTTP ${response.status}).`,
          'server'
        ),
        unauthorized: false
      }
    }
    return { rateLimits: mapGrokBillingPayload(await response.json()), unauthorized: false }
  } catch (error) {
    return {
      rateLimits: makeResult(
        'error',
        error instanceof Error ? error.message : 'Grok billing request failed.',
        'network'
      ),
      unauthorized: false
    }
  }
}

async function refreshGrokAuthAndFetchBilling(
  options: FetchGrokRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const authResult = await authenticateWithGrokCli({ grokHomePath: options.grokHomePath })
  if (authResult.status !== 'ok') {
    return makeResult(authResult.status, authResult.error, authResult.failureKind)
  }
  const tokenResult = readGrokAccessToken(options)
  if (tokenResult.status !== 'ok') {
    return makeResult('error', tokenResult.error, 'missing-credentials')
  }
  return (await fetchGrokBilling(tokenResult.token)).rateLimits
}

export async function fetchGrokRateLimits(
  options: FetchGrokRateLimitsOptions = {}
): Promise<ProviderRateLimits> {
  const tokenResult = readGrokAccessToken(options)
  if (tokenResult.status !== 'ok') {
    return makeResult(
      tokenResult.status === 'missing' ? 'unavailable' : 'error',
      tokenResult.error,
      'missing-credentials'
    )
  }
  if (!tokenResult.expired) {
    const billingResult = await fetchGrokBilling(tokenResult.token)
    if (!billingResult.unauthorized) {
      return billingResult.rateLimits
    }
  }
  return refreshGrokAuthAndFetchBilling(options)
}
