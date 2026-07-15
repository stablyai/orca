import { glabExecFileAsync } from '../git/runner'
import { getSshGitProviderRegistrationId } from '../providers/ssh-git-dispatch'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'

const REMOTE_KNOWN_HOSTS_CACHE_MAX_CONNECTIONS = 128
const LOCAL_CONNECTION_KEY = '\0local'

type KnownHostsCacheEntry = {
  hosts: readonly string[]
  sshProviderRegistrationId: number | undefined
}

type KnownHostsLifecycle = {
  connectionId: string | null
  sshProviderRegistrationId: number | undefined
}

// Why: each SSH target can resolve a different self-hosted GitLab context;
// the local CLI context remains isolated under its own pinned cache key.
const knownHostsCacheByConnection = new Map<string, KnownHostsCacheEntry>()
let knownHostsLifecycleByResult = new WeakMap<readonly string[], KnownHostsLifecycle>()

function connectionCacheKey(connectionId?: string | null): string {
  return connectionId ? `ssh:${connectionId}` : LOCAL_CONNECTION_KEY
}

function sshProviderRegistrationChanged(
  connectionId: string | null | undefined,
  expectedRegistrationId: number | undefined
): boolean {
  if (!connectionId) {
    return false
  }
  return getSshGitProviderRegistrationId(connectionId) !== expectedRegistrationId
}

function staleSshProviderError(connectionId: string | null | undefined): Error {
  return new Error(
    `SSH connection ${connectionId ?? 'unknown'} changed while GitLab auth was resolving`
  )
}

function rememberKnownHostsCacheEntry(
  cacheKey: string,
  entry: KnownHostsCacheEntry,
  connectionId?: string | null
): void {
  knownHostsLifecycleByResult.set(entry.hosts, {
    connectionId: connectionId ?? null,
    sshProviderRegistrationId: entry.sshProviderRegistrationId
  })
  knownHostsCacheByConnection.delete(cacheKey)
  knownHostsCacheByConnection.set(cacheKey, entry)
  const maxEntries =
    REMOTE_KNOWN_HOSTS_CACHE_MAX_CONNECTIONS +
    (knownHostsCacheByConnection.has(LOCAL_CONNECTION_KEY) ? 1 : 0)
  while (knownHostsCacheByConnection.size > maxEntries) {
    const keys = knownHostsCacheByConnection.keys()
    let oldestKey = keys.next().value
    if (oldestKey === LOCAL_CONNECTION_KEY) {
      oldestKey = keys.next().value
    }
    if (oldestKey === undefined) {
      return
    }
    knownHostsCacheByConnection.delete(oldestKey)
  }
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCacheByConnection.clear()
  knownHostsLifecycleByResult = new WeakMap()
}

/** @internal - exposed for tests only */
export function _getKnownHostsCacheSize(): number {
  return knownHostsCacheByConnection.size
}

export function areGlabKnownHostsCurrentForConnection(
  hosts: readonly string[],
  connectionId?: string | null
): boolean {
  const lifecycle = knownHostsLifecycleByResult.get(hosts)
  if (!lifecycle) {
    // Explicit caller-supplied host lists predate lifecycle-tagged cache results.
    return true
  }
  if (lifecycle.connectionId !== (connectionId ?? null)) {
    return false
  }
  return (
    !connectionId ||
    getSshGitProviderRegistrationId(connectionId) === lifecycle.sshProviderRegistrationId
  )
}

export function rememberGlabKnownHost(host: string, connectionId?: string | null): void {
  const normalizedHost = normalizeGitLabHost(host)
  const key = connectionCacheKey(connectionId)
  const cached = knownHostsCacheByConnection.get(key)
  const sshProviderRegistrationId = connectionId
    ? getSshGitProviderRegistrationId(connectionId)
    : undefined
  if (
    !cached ||
    cached.sshProviderRegistrationId !== sshProviderRegistrationId ||
    cached.hosts.map(normalizeGitLabHost).includes(normalizedHost)
  ) {
    return
  }
  rememberKnownHostsCacheEntry(
    key,
    {
      hosts: [...cached.hosts, normalizedHost],
      sshProviderRegistrationId
    },
    connectionId
  )
}

export async function getGlabKnownHosts(connectionId?: string | null): Promise<readonly string[]> {
  const key = connectionCacheKey(connectionId)
  const sshProviderRegistrationId = connectionId
    ? getSshGitProviderRegistrationId(connectionId)
    : undefined
  const cached = knownHostsCacheByConnection.get(key)
  if (cached && cached.sshProviderRegistrationId === sshProviderRegistrationId) {
    rememberKnownHostsCacheEntry(key, cached, connectionId)
    return cached.hosts
  }
  if (cached) {
    knownHostsCacheByConnection.delete(key)
  }
  try {
    // Why: auth status is host-scoped, but the resulting host set must stay
    // isolated from other SSH connection lifecycles and the local context.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'])
    if (sshProviderRegistrationChanged(connectionId, sshProviderRegistrationId)) {
      throw staleSshProviderError(connectionId)
    }
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    const merged = Array.from(new Set([...DEFAULT_GITLAB_HOSTS, ...hosts]))
    rememberKnownHostsCacheEntry(key, { hosts: merged, sshProviderRegistrationId }, connectionId)
    return merged
  } catch {
    // Why: returning even default hosts would let the old request continue
    // project resolution against a replacement provider that reused the id.
    if (sshProviderRegistrationChanged(connectionId, sshProviderRegistrationId)) {
      throw staleSshProviderError(connectionId)
    }
    // Failed auth probes remain retryable after CLI/tunnel readiness changes.
    const fallback = [...DEFAULT_GITLAB_HOSTS]
    knownHostsLifecycleByResult.set(fallback, {
      connectionId: connectionId ?? null,
      sshProviderRegistrationId
    })
    return fallback
  }
}

export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set<string>()
  // Why: self-hosted GitLab can run on a non-default port, so port-qualified
  // services must remain distinct throughout host selection.
  for (const m of output.matchAll(/logged in to ([a-zA-Z0-9.-]+(?::\d+)?)/gi)) {
    hosts.add(m[1].toLowerCase())
  }
  for (const line of output.split('\n')) {
    const bareLine = line.trim()
    const hostLine = bareLine.endsWith(':') ? bareLine.slice(0, -1) : bareLine
    if (
      line === bareLine &&
      /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?(?::\d+)?$/.test(hostLine)
    ) {
      hosts.add(hostLine.toLowerCase())
    }
  }
  return Array.from(hosts)
}
