import { glabExecFileAsync } from '../git/runner'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'

export type LocalGitExecOptions = {
  wslDistro?: string
}

const GLAB_KNOWN_HOSTS_TIMEOUT_MS = 10_000
export const GLAB_KNOWN_HOSTS_OUTPUT_MAX_BYTES = 1024 * 1024
export const GLAB_KNOWN_HOSTS_CONTEXT_MAX_ENTRIES = 64
export const GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES = 4 * 1024
export const GLAB_KNOWN_HOSTS_CONTEXT_KEYS_MAX_BYTES = 128 * 1024
export const GLAB_KNOWN_HOSTS_MAX_ENTRIES = 64
export const GLAB_KNOWN_HOST_MAX_BYTES = 1024
export const GLAB_KNOWN_HOSTS_MAX_BYTES = 32 * 1024
export const GLAB_KNOWN_HOSTS_MAX_IN_FLIGHT = 16

type KnownHostsCacheEntry = {
  hosts: readonly string[]
  keyBytes: number
}

type KnownHostRetention = {
  hosts: string[]
  retainedBytes: number
  protectedEntries: number
}

const knownHostsCacheByExecutionContext = new Map<string, KnownHostsCacheEntry>()
const knownHostsInFlightByExecutionContext = new Map<string, Promise<readonly string[]>>()
let knownHostsCachedContextKeyBytes = 0

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function knownHostsExecutionKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string | null {
  let key: string
  if (connectionId) {
    if (utf8Bytes(connectionId) > GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES) {
      return null
    }
    // Why: reconnecting can replace the SSH/relay execution host under the same id.
    key = `connection:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
  } else if (localGitOptions.wslDistro) {
    if (utf8Bytes(localGitOptions.wslDistro) > GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES) {
      return null
    }
    key = `wsl:${localGitOptions.wslDistro}`
  } else {
    key = 'native'
  }
  return utf8Bytes(key) <= GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES ? key : null
}

function deleteCachedContext(key: string): void {
  const cached = knownHostsCacheByExecutionContext.get(key)
  if (!cached) {
    return
  }
  knownHostsCachedContextKeyBytes -= cached.keyBytes
  knownHostsCacheByExecutionContext.delete(key)
}

function getCachedHosts(key: string): readonly string[] | undefined {
  const cached = knownHostsCacheByExecutionContext.get(key)
  if (!cached) {
    return undefined
  }
  knownHostsCacheByExecutionContext.delete(key)
  knownHostsCacheByExecutionContext.set(key, cached)
  return cached.hosts
}

function createKnownHostRetention(includeDefaults: boolean): KnownHostRetention {
  const hosts = includeDefaults ? [...DEFAULT_GITLAB_HOSTS] : []
  return {
    hosts,
    retainedBytes: hosts.reduce((total, host) => total + utf8Bytes(host), 0),
    protectedEntries: hosts.length
  }
}

function retainKnownHost(retention: KnownHostRetention, host: string): void {
  if (utf8Bytes(host) > GLAB_KNOWN_HOST_MAX_BYTES) {
    return
  }
  const normalized = normalizeGitLabHost(host)
  const hostBytes = utf8Bytes(normalized)
  if (
    hostBytes === 0 ||
    hostBytes > GLAB_KNOWN_HOST_MAX_BYTES ||
    retention.hosts.includes(normalized)
  ) {
    return
  }
  while (
    retention.hosts.length > retention.protectedEntries &&
    (retention.hosts.length >= GLAB_KNOWN_HOSTS_MAX_ENTRIES ||
      retention.retainedBytes + hostBytes > GLAB_KNOWN_HOSTS_MAX_BYTES)
  ) {
    const removed = retention.hosts.splice(retention.protectedEntries, 1)[0]
    retention.retainedBytes -= utf8Bytes(removed)
  }
  if (
    retention.hosts.length >= GLAB_KNOWN_HOSTS_MAX_ENTRIES ||
    retention.retainedBytes + hostBytes > GLAB_KNOWN_HOSTS_MAX_BYTES
  ) {
    return
  }
  retention.hosts.push(normalized)
  retention.retainedBytes += hostBytes
}

function retainKnownHosts(hosts: Iterable<string>): readonly string[] {
  const retention = createKnownHostRetention(true)
  for (const host of hosts) {
    retainKnownHost(retention, host)
  }
  return retention.hosts
}

function cacheKnownHosts(key: string, hosts: Iterable<string>): readonly string[] {
  const retained = retainKnownHosts(hosts)
  const keyBytes = utf8Bytes(key)
  deleteCachedContext(key)
  while (
    knownHostsCacheByExecutionContext.size >= GLAB_KNOWN_HOSTS_CONTEXT_MAX_ENTRIES ||
    knownHostsCachedContextKeyBytes + keyBytes > GLAB_KNOWN_HOSTS_CONTEXT_KEYS_MAX_BYTES
  ) {
    const oldestKey = knownHostsCacheByExecutionContext.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    deleteCachedContext(oldestKey)
  }
  knownHostsCacheByExecutionContext.set(key, { hosts: retained, keyBytes })
  knownHostsCachedContextKeyBytes += keyBytes
  return retained
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCacheByExecutionContext.clear()
  knownHostsInFlightByExecutionContext.clear()
  knownHostsCachedContextKeyBytes = 0
}

/** @internal - exposed for tests only */
export function _getKnownHostsCacheState(): {
  cachedContexts: number
  cachedContextKeyBytes: number
  inFlightContexts: number
} {
  return {
    cachedContexts: knownHostsCacheByExecutionContext.size,
    cachedContextKeyBytes: knownHostsCachedContextKeyBytes,
    inFlightContexts: knownHostsInFlightByExecutionContext.size
  }
}

export function rememberGlabKnownHost(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  if (!key || utf8Bytes(host) > GLAB_KNOWN_HOST_MAX_BYTES) {
    return
  }
  const normalizedHost = normalizeGitLabHost(host)
  if (utf8Bytes(normalizedHost) > GLAB_KNOWN_HOST_MAX_BYTES) {
    return
  }
  const cached = getCachedHosts(key)
  if (!cached || cached.includes(normalizedHost)) {
    return
  }
  cacheKnownHosts(key, [...cached, normalizedHost])
}

export async function getGlabKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  if (!key) {
    return [...DEFAULT_GITLAB_HOSTS]
  }
  const cached = getCachedHosts(key)
  if (cached) {
    return cached
  }
  const inFlight = knownHostsInFlightByExecutionContext.get(key)
  if (inFlight) {
    return inFlight
  }
  if (knownHostsInFlightByExecutionContext.size >= GLAB_KNOWN_HOSTS_MAX_IN_FLIGHT) {
    return [...DEFAULT_GITLAB_HOSTS]
  }
  const probe = probeGlabKnownHosts(key, connectionId, localGitOptions)
  knownHostsInFlightByExecutionContext.set(key, probe)
  try {
    return await probe
  } finally {
    if (knownHostsInFlightByExecutionContext.get(key) === probe) {
      knownHostsInFlightByExecutionContext.delete(key)
    }
  }
}

async function probeGlabKnownHosts(
  key: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  try {
    // Why: auth config belongs to the executing host; do not share native, WSL,
    // or reconnected SSH/relay results, and bound an otherwise global probe.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'], {
      timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS,
      maxBuffer: GLAB_KNOWN_HOSTS_OUTPUT_MAX_BYTES,
      ...(!connectionId && localGitOptions.wslDistro
        ? { wslDistro: localGitOptions.wslDistro }
        : {})
    })
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    return cacheKnownHosts(key, hosts)
  } catch {
    // Keep failures uncached so auth or tunnel recovery is discovered later.
    return [...DEFAULT_GITLAB_HOSTS]
  }
}

export function parseGlabAuthStatusHosts(output: string): string[] {
  const retention = createKnownHostRetention(false)
  // Why: self-hosted GitLab can run on a non-default port; preserve it so
  // services on the same hostname remain distinct downstream.
  for (const match of output.matchAll(/logged in to ([a-zA-Z0-9.-]+(?::\d+)?)/gi)) {
    retainKnownHost(retention, match[1].toLowerCase())
  }
  for (const line of output.split('\n')) {
    const bareLine = line.trim()
    const hostLine = bareLine.endsWith(':') ? bareLine.slice(0, -1) : bareLine
    if (
      line === bareLine &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?$/.test(hostLine)
    ) {
      retainKnownHost(retention, hostLine.toLowerCase())
    }
  }
  return retention.hosts
}
