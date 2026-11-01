import { teaExecFileAsync } from '../git/runner'
import type { TeaExecOptions } from '../git/command-runner/tea-exec-file'
import { acquire, release } from './tea-admission'
import { teaApiWithHeaders } from './tea-api-response'
import { normalizeGiteaApiBaseUrl } from './client'
import {
  parseTeaLoginStatus,
  rememberTeaKnownHosts,
  rememberTeaKnownLogins,
  teaHostFromInstanceUrl,
  type TeaKnownLogin
} from './gitea-known-host-probe'

export type GiteaAuthDiagnostic = {
  teaAvailable: boolean
  authenticated: boolean
  hosts: string[]
  activeHost: string | null
  logins: readonly TeaKnownLogin[]
  envTokenInProcess: 'ORCA_GITEA_TOKEN' | 'GITEA_TOKEN' | null
  error: string | null
}

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
  const tea = process.env.GITEA_INSTANCE_URL?.trim()
  return tea || null
}

function isMissingTea(error: unknown, message: string): boolean {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
    return true
  }
  return /ENOENT|not found|spawn/i.test(message)
}

function activeHostFor(logins: readonly TeaKnownLogin[], hosts: readonly string[]): string | null {
  return logins.find((login) => login.isDefault)?.host ?? hosts[0] ?? null
}

export async function diagnoseGiteaAuth(): Promise<GiteaAuthDiagnostic> {
  const tokenName = envTokenInProcess()
  try {
    // A host-global auth diagnostic must not wake the default WSL distro.
    const { stdout } = await teaExecFileAsync(['login', 'status', '-o', 'json'], {
      allowDefaultWslFallback: false
    })
    const logins = parseTeaLoginStatus(stdout)
    const hosts = logins.map((login) => login.host)
    if (hosts.length === 0 && tokenName) {
      const instance = envInstanceUrl()
      const envHost = instance ? teaHostFromInstanceUrl(instance) : null
      const envHosts = envHost ? [envHost] : []
      rememberTeaKnownHosts(envHosts)
      return {
        teaAvailable: true,
        authenticated: true,
        hosts: envHosts,
        activeHost: envHost,
        logins,
        envTokenInProcess: tokenName,
        error: null
      }
    }
    rememberTeaKnownLogins(logins)
    rememberTeaKnownHosts(hosts)
    return {
      teaAvailable: true,
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
    const envHost = tokenName && instance ? teaHostFromInstanceUrl(instance) : null
    const hosts = envHost ? [envHost] : []
    rememberTeaKnownHosts(hosts)
    return {
      teaAvailable: !isMissingTea(error, message),
      authenticated: tokenName !== null,
      hosts,
      activeHost: envHost,
      logins: [],
      envTokenInProcess: tokenName,
      error: message
    }
  }
}

export type GiteaViewer = {
  username: string
  email: string | null
}

export type GiteaRateLimitBucket = {
  limit: number
  remaining: number
  resetAt: number | null
}

export type GiteaRateLimitSnapshot = {
  rest: GiteaRateLimitBucket | null
  host: string | null
  fetchedAt: number
}

export type GetGiteaRateLimitResult =
  | { ok: true; snapshot: GiteaRateLimitSnapshot }
  | { ok: false; error: string }

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

function viewerTarget(loginOrHost?: string | null): { args: string[]; options: TeaExecOptions } {
  const target = loginOrHost?.trim() ?? ''
  if (!target) {
    return { args: ['api', '/user'], options: {} }
  }
  if (
    target.includes('://') ||
    target.includes('.') ||
    target.includes(':') ||
    target.includes('/')
  ) {
    const instanceUrl = target.includes('://') ? target : `https://${target}`
    return {
      args: ['api', '/user'],
      options: { env: { ...process.env, GITEA_INSTANCE_URL: instanceUrl } }
    }
  }
  return { args: ['api', '--login', target, '/user'], options: {} }
}

async function fetchAuthenticatedViewer(loginOrHost?: string | null): Promise<GiteaViewer | null> {
  const token = process.env.ORCA_GITEA_TOKEN?.trim() || process.env.GITEA_TOKEN?.trim() || ''
  const target = loginOrHost?.trim() ?? ''
  const base =
    target.includes('://') || target.includes('.') || target.includes(':') || target.includes('/')
      ? target.includes('://')
        ? target
        : `https://${target}`
      : envInstanceUrl()
  if (!token || !base) {
    return null
  }
  const response = await fetch(`${normalizeGiteaApiBaseUrl(base)}/user`, {
    headers: {
      Accept: 'application/json',
      Authorization: `token ${token}`
    }
  })
  if (!response.ok) {
    return null
  }
  return viewerFromUnknown(await response.json())
}

export async function getAuthenticatedViewer(
  loginOrHost?: string | null
): Promise<GiteaViewer | null> {
  const target = viewerTarget(loginOrHost)
  await acquire()
  try {
    const { stdout } = await teaExecFileAsync(target.args, target.options)
    try {
      return viewerFromUnknown(JSON.parse(stdout))
    } catch (error) {
      if (error instanceof SyntaxError) {
        return null
      }
      throw error
    }
  } catch {
    return fetchAuthenticatedViewer(loginOrHost)
  } finally {
    release()
  }
}

function parseRateLimitHeader(
  headers: Record<string, string>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = Number.parseInt(headers[key] ?? '', 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function parseGiteaRateLimitSnapshot(
  headers: Record<string, string>,
  host: string | null
): GiteaRateLimitSnapshot {
  const limit = parseRateLimitHeader(headers, ['x-ratelimit-limit', 'ratelimit-limit'])
  const remaining = parseRateLimitHeader(headers, ['x-ratelimit-remaining', 'ratelimit-remaining'])
  const resetAt = parseRateLimitHeader(headers, ['x-ratelimit-reset', 'ratelimit-reset'])
  return {
    host,
    fetchedAt: Date.now(),
    rest:
      limit === null && remaining === null && resetAt === null
        ? null
        : { limit: limit ?? 0, remaining: remaining ?? 0, resetAt }
  }
}

/** @internal — test-only */
export function _resetGiteaRateLimitCache(): void {
  giteaRateLimitCache.clear()
}

/** @internal — test-only */
export function _getGiteaRateLimitCacheSize(): number {
  return giteaRateLimitCache.size
}

function pruneGiteaRateLimitCache(now = Date.now()): void {
  for (const [cacheKey, snapshot] of giteaRateLimitCache) {
    if (now - snapshot.fetchedAt >= GITEA_RATE_LIMIT_CACHE_TTL_MS) {
      giteaRateLimitCache.delete(cacheKey)
    }
  }
  while (giteaRateLimitCache.size > GITEA_RATE_LIMIT_CACHE_MAX_ENTRIES) {
    const oldestKey = giteaRateLimitCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    giteaRateLimitCache.delete(oldestKey)
  }
}

function rememberGiteaRateLimitSnapshot(cacheKey: string, snapshot: GiteaRateLimitSnapshot): void {
  pruneGiteaRateLimitCache()
  giteaRateLimitCache.delete(cacheKey)
  giteaRateLimitCache.set(cacheKey, snapshot)
  pruneGiteaRateLimitCache()
}

function instanceUrlForHost(host: string): string {
  return host.includes('://') ? host : `https://${host}`
}

export async function getRateLimit(options?: {
  force?: boolean
  host?: string | null
}): Promise<GetGiteaRateLimitResult> {
  const host = options?.host?.trim() || null
  const cacheKey = host ?? 'default'
  pruneGiteaRateLimitCache()
  const cached = giteaRateLimitCache.get(cacheKey)
  if (!options?.force && cached && Date.now() - cached.fetchedAt < GITEA_RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached }
  }

  await acquire()
  try {
    const execOptions: TeaExecOptions = host
      ? { env: { ...process.env, GITEA_INSTANCE_URL: instanceUrlForHost(host) } }
      : {}
    const { headers } = await teaApiWithHeaders(['/user'], execOptions)
    const snapshot = parseGiteaRateLimitSnapshot(headers, host)
    rememberGiteaRateLimitSnapshot(cacheKey, snapshot)
    return { ok: true, snapshot }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    release()
  }
}
