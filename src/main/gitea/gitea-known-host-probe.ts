import { runCoalescedProbe, type CoalescedProbes } from '../git/remotes/coalesced-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remotes/remote-ref-probe-cache'
import { gtExecFileAsync } from '../git/command-runner/gt-exec-file'
import type { GitAdmissionTier } from '../../shared/rpc-contract/source-control/git-admission-tier-params'
import type { GiteaKnownLogin } from '../../shared/gitea-types'

export type { GiteaKnownLogin }

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const GT_KNOWN_HOSTS_TIMEOUT_MS = 10_000
export const KNOWN_HOSTS_CACHE_MAX_ENTRIES = 128
export const KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS = 15_000

const loginsCacheByExecutionContext = new Map<string, readonly GiteaKnownLogin[]>()
const loginsFailureBackoff = new Map<
  string,
  { retryAt: number; delayMs: number; logins: readonly GiteaKnownLogin[] }
>()
const loginsInFlightByExecutionContext: CoalescedProbes<readonly GiteaKnownLogin[]> = new Map()
const hostsByLoginList = new WeakMap<readonly GiteaKnownLogin[], readonly string[]>()

let cachedGtVersion: { version: string | null; checkedAt: number } | null = null
const GT_VERSION_CACHE_TTL_MS = 60_000

function executionKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  if (connectionId) {
    return `connection:${connectionId}`
  }
  return localGitOptions.wslDistro ? `wsl:${localGitOptions.wslDistro}` : 'native'
}

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

function readBool(value: unknown): boolean {
  return value === true || value === 'true'
}

/** Keep URL ports and subpaths so self-hosted Gitea instances stay distinct. */
export function giteaHostFromInstanceUrl(url: string): string {
  const trimmed = url.trim()
  try {
    const parsed = new URL(trimmed)
    const path = parsed.pathname.replace(/\/+$/, '').replace(/^\/+/, '')
    const host = parsed.host.toLowerCase()
    return path ? `${host}/${path}` : host
  } catch {
    return trimmed.toLowerCase()
  }
}

export function parseGtVersion(output: string): string | null {
  const match = /gt\s+version\s+([0-9a-zA-Z.-]+)/i.exec(output)
  return match?.[1] ?? null
}

export async function probeGtVersion(): Promise<string | null> {
  if (cachedGtVersion && Date.now() - cachedGtVersion.checkedAt < GT_VERSION_CACHE_TTL_MS) {
    return cachedGtVersion.version
  }
  try {
    const { stdout } = await gtExecFileAsync(['--version'], {
      allowDefaultWslFallback: false,
      timeout: 5000
    })
    const version = parseGtVersion(stdout)
    cachedGtVersion = { version, checkedAt: Date.now() }
    return version
  } catch {
    cachedGtVersion = { version: null, checkedAt: Date.now() }
    return null
  }
}

function loginFromRecord(record: Record<string, unknown>): GiteaKnownLogin | null {
  const rawHost = readString(record, ['host', 'url', 'URL'])
  if (!rawHost) {
    return null
  }
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawHost) ? rawHost : `https://${rawHost}`
  const host = giteaHostFromInstanceUrl(url)
  const sshHost =
    readString(record, ['ssh_host', 'sshHost', 'SSHHost']) || host.split('/')[0] || host
  const user = readString(record, ['user', 'User', 'username', 'login'])
  const isDefault = readBool(record.active ?? record.default ?? record.isDefault)
  const name = user ? `${user}@${host}` : host
  return {
    name,
    url,
    host,
    sshHost,
    user,
    isDefault
  }
}

export function parseGtLoginStatus(stdout: string): GiteaKnownLogin[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const logins: GiteaKnownLogin[] = []
  for (const row of parsed) {
    if (!isRecord(row)) {
      continue
    }
    const login = loginFromRecord(row)
    if (login) {
      logins.push(login)
    }
  }
  return logins
}

/** @internal - exposed for tests only */
export function _resetGtKnownHostsCache(): void {
  loginsCacheByExecutionContext.clear()
  loginsInFlightByExecutionContext.clear()
  loginsFailureBackoff.clear()
  cachedGtVersion = null
}

function trimLoginsCache(): void {
  while (loginsCacheByExecutionContext.size > KNOWN_HOSTS_CACHE_MAX_ENTRIES) {
    const oldest = loginsCacheByExecutionContext.keys().next()
    if (oldest.done) {
      break
    }
    loginsCacheByExecutionContext.delete(oldest.value)
  }
}

export function rememberGtKnownLogins(
  logins: readonly GiteaKnownLogin[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = executionKey(connectionId, localGitOptions)
  loginsFailureBackoff.delete(key)
  if (logins.length === 0) {
    return
  }
  loginsCacheByExecutionContext.delete(key)
  loginsCacheByExecutionContext.set(key, logins)
  trimLoginsCache()
}

export function rememberGtKnownHosts(
  hosts: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = executionKey(connectionId, localGitOptions)
  const existing = loginsCacheByExecutionContext.get(key) ?? []
  const known = new Set(existing.map((login) => login.host.toLowerCase()))
  const additions: GiteaKnownLogin[] = []
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase()
    if (!normalized || known.has(normalized)) {
      continue
    }
    known.add(normalized)
    additions.push({
      name: normalized,
      url: `https://${normalized}`,
      host: normalized,
      sshHost: normalized.split('/')[0] ?? normalized,
      user: '',
      isDefault: false
    })
  }
  if (additions.length > 0) {
    rememberGtKnownLogins([...existing, ...additions], connectionId, localGitOptions)
  }
}

export function extractGiteaHostsFromLogins(logins: readonly GiteaKnownLogin[]): readonly string[] {
  const cached = hostsByLoginList.get(logins)
  if (cached) {
    return cached
  }
  const hosts = [...new Set(logins.map((login) => login.host.toLowerCase()))]
  hostsByLoginList.set(logins, hosts)
  return hosts
}

export async function getGtKnownLogins(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly GiteaKnownLogin[]> {
  const key = executionKey(connectionId, localGitOptions)
  const cached = loginsCacheByExecutionContext.get(key)
  if (cached) {
    return cached
  }

  const backoff = loginsFailureBackoff.get(key)
  if (backoff && Date.now() < backoff.retryAt) {
    return backoff.logins
  }

  return runCoalescedProbe(loginsInFlightByExecutionContext, key, async () => {
    try {
      const { stdout } = await gtExecFileAsync(
        [
          'auth',
          'status',
          '--json',
          'active,credential_available,credential_store,error,expires_at,git_credential_helper,host,method,scopes,user,verified'
        ],
        {
          wslDistro: localGitOptions.wslDistro,
          timeout: GT_KNOWN_HOSTS_TIMEOUT_MS,
          allowDefaultWslFallback: false
        }
      )
      const logins = parseGtLoginStatus(stdout)
      rememberGtKnownLogins(logins, connectionId, localGitOptions)
      return logins
    } catch {
      const fallbackLogins = backoff?.logins ?? []
      const nextDelayMs = backoff
        ? Math.min(backoff.delayMs * 2, NEGATIVE_ENTRY_TTL_MS)
        : KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
      loginsFailureBackoff.set(key, {
        retryAt: Date.now() + nextDelayMs,
        delayMs: nextDelayMs,
        logins: fallbackLogins
      })
      return fallbackLogins
    }
  })
}

export async function getGtKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const logins = await getGtKnownLogins(connectionId, localGitOptions)
  return extractGiteaHostsFromLogins(logins)
}
