import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { teaExecFileAsync } from '../git/runner'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

export type TeaKnownLogin = {
  name: string
  url: string
  host: string
  sshHost: string
  user: string
  isDefault: boolean
}

const TEA_KNOWN_HOSTS_TIMEOUT_MS = 10_000
export const KNOWN_HOSTS_CACHE_MAX_ENTRIES = 128
export const KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS = 15_000

const loginsCacheByExecutionContext = new Map<string, readonly TeaKnownLogin[]>()
const loginsFailureBackoff = new Map<
  string,
  { retryAt: number; delayMs: number; logins: readonly TeaKnownLogin[] }
>()
const loginsInFlightByExecutionContext: CoalescedProbes<readonly TeaKnownLogin[]> = new Map()
const hostsByLoginList = new WeakMap<readonly TeaKnownLogin[], readonly string[]>()

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
export function teaHostFromInstanceUrl(url: string): string {
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

function loginFromRecord(
  record: Record<string, unknown>,
  requireValid: boolean
): TeaKnownLogin | null {
  if (requireValid && !readBool(record.valid)) {
    return null
  }
  const url = readString(record, ['url', 'URL'])
  if (!url) {
    return null
  }
  const host = teaHostFromInstanceUrl(url)
  const sshHost =
    readString(record, ['ssh_host', 'sshHost', 'SSHHost']) || host.split('/')[0] || host
  return {
    name: readString(record, ['name', 'Name']),
    url,
    host,
    sshHost,
    user: readString(record, ['user', 'User']),
    isDefault: readBool(record.default ?? record.isDefault ?? record.is_default)
  }
}

function parseLoginRows(stdout: string, requireValid: boolean): TeaKnownLogin[] {
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    throw new Error('tea login output was not a JSON array')
  }
  const logins: TeaKnownLogin[] = []
  for (const row of parsed) {
    if (!isRecord(row)) {
      continue
    }
    const login = loginFromRecord(row, requireValid)
    if (login) {
      logins.push(login)
    }
  }
  return logins
}

export function parseTeaLoginList(stdout: string): TeaKnownLogin[] {
  return parseLoginRows(stdout, false)
}

export function parseTeaLoginStatus(stdout: string): TeaKnownLogin[] {
  return parseLoginRows(stdout, true)
}

/** @internal - exposed for tests only */
export function _resetTeaKnownHostsCache(): void {
  loginsCacheByExecutionContext.clear()
  loginsInFlightByExecutionContext.clear()
  loginsFailureBackoff.clear()
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

export function rememberTeaKnownLogins(
  logins: readonly TeaKnownLogin[],
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

export function rememberTeaKnownHosts(
  hosts: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = executionKey(connectionId, localGitOptions)
  const partial = loginsFailureBackoff.get(key)
  loginsFailureBackoff.delete(key)
  const cached = loginsCacheByExecutionContext.get(key) ?? []
  const seen = new Set(cached.map((login) => login.host))
  const additions: TeaKnownLogin[] = []
  for (const host of hosts) {
    const normalizedHost = host.trim().toLowerCase()
    if (!normalizedHost || seen.has(normalizedHost)) {
      continue
    }
    seen.add(normalizedHost)
    const sshHost = normalizedHost.split('/')[0] || normalizedHost
    additions.push({
      name: '',
      url: normalizedHost.includes('://') ? normalizedHost : `https://${normalizedHost}`,
      host: normalizedHost,
      sshHost,
      user: '',
      isDefault: false
    })
  }
  if (additions.length === 0) {
    if (!loginsCacheByExecutionContext.has(key) && partial?.logins.length) {
      loginsFailureBackoff.set(key, { logins: partial.logins, retryAt: 0, delayMs: 0 })
    }
    return
  }
  loginsCacheByExecutionContext.set(key, [...cached, ...additions])
  trimLoginsCache()
}

function rememberLoginsFailure(key: string): void {
  const previousDelayMs = loginsFailureBackoff.get(key)?.delayMs
  const delayMs = previousDelayMs
    ? Math.min(previousDelayMs * 2, NEGATIVE_ENTRY_TTL_MS)
    : KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
  const partial = loginsFailureBackoff.get(key)?.logins ?? []
  loginsFailureBackoff.delete(key)
  loginsFailureBackoff.set(key, {
    retryAt: Date.now() + delayMs,
    delayMs,
    logins: partial
  })
  while (loginsFailureBackoff.size > KNOWN_HOSTS_CACHE_MAX_ENTRIES) {
    const oldestKey = loginsFailureBackoff.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    loginsFailureBackoff.delete(oldestKey)
  }
}

export async function getTeaKnownLogins(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly TeaKnownLogin[]> {
  const key = executionKey(connectionId, localGitOptions)
  const cached = loginsCacheByExecutionContext.get(key)
  if (cached) {
    loginsCacheByExecutionContext.delete(key)
    loginsCacheByExecutionContext.set(key, cached)
    return cached
  }
  if ((loginsFailureBackoff.get(key)?.retryAt ?? 0) > Date.now()) {
    return loginsFailureBackoff.get(key)?.logins ?? []
  }
  return runCoalescedProbe(loginsInFlightByExecutionContext, key, (ownsKey) =>
    probeTeaKnownLogins(key, ownsKey, connectionId, localGitOptions)
  )
}

export async function getTeaKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const logins = await getTeaKnownLogins(connectionId, localGitOptions)
  const cachedHosts = hostsByLoginList.get(logins)
  if (cachedHosts) {
    return cachedHosts
  }
  const hosts = logins.map((login) => login.host)
  hostsByLoginList.set(logins, hosts)
  return hosts
}

async function probeTeaKnownLogins(
  key: string,
  ownsKey: () => boolean,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly TeaKnownLogin[]> {
  try {
    const { stdout } = await teaExecFileAsync(['login', 'list', '-o', 'json'], {
      timeout: TEA_KNOWN_HOSTS_TIMEOUT_MS,
      // Native probes must not wake a stopped default distro; connection probes may.
      ...(connectionId ? {} : { allowDefaultWslFallback: false }),
      ...(!connectionId && localGitOptions.wslDistro
        ? { wslDistro: localGitOptions.wslDistro }
        : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    const logins = parseTeaLoginList(stdout)
    if (ownsKey()) {
      loginsFailureBackoff.delete(key)
      loginsCacheByExecutionContext.delete(key)
      loginsCacheByExecutionContext.set(key, logins)
      trimLoginsCache()
    }
    return logins
  } catch {
    if (ownsKey()) {
      rememberLoginsFailure(key)
    }
    return loginsCacheByExecutionContext.get(key) ?? loginsFailureBackoff.get(key)?.logins ?? []
  }
}
