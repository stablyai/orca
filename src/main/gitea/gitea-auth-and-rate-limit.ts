import { gtExecFileAsync, type GtExecOptions } from '../git/command-runner/gt-exec-file'
import { acquire, release } from './gt-admission'
import { gtApiWithHeaders } from './gt-api-response'
import { normalizeGiteaApiBaseUrl } from './client'
import {
  parseGtLoginStatus,
  probeGtVersion,
  rememberGtKnownHosts,
  rememberGtKnownLogins,
  giteaHostFromInstanceUrl,
  type GiteaKnownLogin
} from './gitea-known-host-probe'
import type {
  GiteaAuthDiagnostic,
  GiteaViewer,
  GiteaRateLimitSnapshot,
  GetGiteaRateLimitResult
} from '../../shared/gitea-types'

export type { GiteaAuthDiagnostic, GiteaViewer, GiteaRateLimitSnapshot, GetGiteaRateLimitResult }

function envTokenInProcess(): GiteaAuthDiagnostic['envTokenInProcess'] {
  if (process.env.ORCA_GITEA_TOKEN?.trim()) {
    return 'ORCA_GITEA_TOKEN'
  }
  if (process.env.GITEA_TOKEN?.trim()) {
    return 'GITEA_TOKEN'
  }
  return null
}

function envInstanceUrl(): string | null {
  const orca = process.env.ORCA_GITEA_API_BASE_URL?.trim()
  if (orca) {
    return orca
  }
  const gt = process.env.GITEA_CLI_HOST?.trim() || process.env.GITEA_INSTANCE_URL?.trim()
  return gt || null
}

function isMissingGt(error: unknown, message: string): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return true
  }
  return /ENOENT|not found|spawn/i.test(message)
}

function activeHostFor(
  logins: readonly GiteaKnownLogin[],
  hosts: readonly string[]
): string | null {
  return logins.find((login) => login.isDefault)?.host ?? hosts[0] ?? null
}

export async function diagnoseGiteaAuth(): Promise<GiteaAuthDiagnostic> {
  const tokenName = envTokenInProcess()
  const version = await probeGtVersion()
  try {
    const { stdout } = await gtExecFileAsync(
      [
        'auth',
        'status',
        '--json',
        'active,credential_available,credential_store,error,expires_at,git_credential_helper,host,method,scopes,user,verified'
      ],
      {
        allowDefaultWslFallback: false
      }
    )
    const logins = parseGtLoginStatus(stdout)
    const hosts = logins.map((login) => login.host)
    if (hosts.length === 0 && tokenName) {
      const instance = envInstanceUrl()
      const envHost = instance ? giteaHostFromInstanceUrl(instance) : null
      const envHosts = envHost ? [envHost] : []
      rememberGtKnownHosts(envHosts)
      return {
        gtAvailable: true,
        gtVersion: version,
        authenticated: true,
        hosts: envHosts,
        activeHost: envHost,
        logins,
        envTokenInProcess: tokenName,
        error: null
      }
    }
    rememberGtKnownLogins(logins)
    rememberGtKnownHosts(hosts)
    return {
      gtAvailable: true,
      gtVersion: version,
      authenticated: logins.length > 0 || tokenName !== null,
      hosts,
      activeHost: activeHostFor(logins, hosts),
      logins,
      envTokenInProcess: tokenName,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const instance = envInstanceUrl()
    const envHost = tokenName && instance ? giteaHostFromInstanceUrl(instance) : null
    const hosts = envHost ? [envHost] : []
    rememberGtKnownHosts(hosts)
    return {
      gtAvailable: !isMissingGt(error, message),
      gtVersion: version,
      authenticated: tokenName !== null,
      hosts,
      activeHost: envHost,
      logins: [],
      envTokenInProcess: tokenName,
      error: message
    }
  }
}

const GITEA_RATE_LIMIT_CACHE_TTL_MS = 30_000
const GITEA_RATE_LIMIT_CACHE_MAX_ENTRIES = 64
const giteaRateLimitCache = new Map<string, GiteaRateLimitSnapshot>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return ''
}

function viewerFromUnknown(value: unknown): GiteaViewer | null {
  if (!isRecord(value)) {
    return null
  }
  const username = readString(value, ['login', 'username'])
  if (!username) {
    return null
  }
  const email = readString(value, ['email'])
  return { username, email: email || null }
}

function viewerTarget(loginOrHost?: string | null): { args: string[]; options: GtExecOptions } {
  const target = loginOrHost?.trim() ?? ''
  if (!target) {
    return { args: [], options: {} }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) || target.includes('.')) {
    return { args: [], options: { host: target } }
  }
  return { args: [], options: {} }
}

export async function getAuthenticatedViewer(
  loginOrHost?: string | null
): Promise<GiteaViewer | null> {
  await acquire()
  try {
    const { args, options } = viewerTarget(loginOrHost)
    const { body, status } = await gtApiWithHeaders(['user', ...args], options)
    if (status >= 200 && status < 300 && body.trim()) {
      const parsed: unknown = JSON.parse(body)
      return viewerFromUnknown(parsed)
    }
    return null
  } catch {
    const token = process.env.ORCA_GITEA_TOKEN || process.env.GITEA_TOKEN
    const baseUrl = process.env.ORCA_GITEA_API_BASE_URL || loginOrHost
    if (!token || !baseUrl || !/^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl)) {
      return null
    }
    try {
      const apiBase = normalizeGiteaApiBaseUrl(baseUrl)
      const res = await fetch(`${apiBase}/user`, {
        headers: {
          Accept: 'application/json',
          Authorization: `token ${token}`
        },
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) {
        return null
      }
      const data: unknown = await res.json()
      return viewerFromUnknown(data)
    } catch {
      return null
    }
  } finally {
    release()
  }
}

function parseRateLimitHeader(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function parseRateLimitReset(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const epoch = Number(value)
  if (Number.isFinite(epoch) && epoch > 0) {
    return epoch > 1e11 ? epoch : epoch * 1000
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? date : null
}

function snapshotFromHeaders(
  headers: Record<string, string>,
  host: string | null
): GiteaRateLimitSnapshot {
  const limit = parseRateLimitHeader(headers['x-ratelimit-limit'])
  const remaining = parseRateLimitHeader(headers['x-ratelimit-remaining'])
  const resetAt = parseRateLimitReset(headers['x-ratelimit-reset'])
  const bucket = limit !== null && remaining !== null ? { limit, remaining, resetAt } : null
  return {
    rest: bucket,
    host,
    fetchedAt: Date.now()
  }
}

export async function getGiteaRateLimit(
  optionsOrHost?: string | null | { force?: boolean; host?: string | null }
): Promise<GetGiteaRateLimitResult> {
  const host =
    typeof optionsOrHost === 'string'
      ? optionsOrHost
      : optionsOrHost && typeof optionsOrHost === 'object'
        ? optionsOrHost.host
        : null
  const force =
    typeof optionsOrHost === 'object' && optionsOrHost !== null
      ? Boolean(optionsOrHost.force)
      : false
  const normalizedHost = host?.trim().toLowerCase() || null
  const cacheKey = normalizedHost ?? 'default'
  const cached = giteaRateLimitCache.get(cacheKey)
  if (!force && cached && Date.now() - cached.fetchedAt < GITEA_RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached }
  }

  await acquire()
  try {
    const { options } = viewerTarget(normalizedHost)
    const { headers } = await gtApiWithHeaders(['user'], options)
    const snapshot = snapshotFromHeaders(headers, normalizedHost)
    giteaRateLimitCache.set(cacheKey, snapshot)
    if (giteaRateLimitCache.size > GITEA_RATE_LIMIT_CACHE_MAX_ENTRIES) {
      const oldest = giteaRateLimitCache.keys().next().value
      if (oldest !== undefined) {
        giteaRateLimitCache.delete(oldest)
      }
    }
    return { ok: true, snapshot }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err)
    }
  } finally {
    release()
  }
}

export { getGiteaRateLimit as getRateLimit }
