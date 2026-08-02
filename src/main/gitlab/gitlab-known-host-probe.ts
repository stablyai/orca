import { glabExecFileAsync } from '../git/runner'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'

export type LocalGitExecOptions = {
  wslDistro?: string
}

const GLAB_KNOWN_HOSTS_TIMEOUT_MS = 10_000
const GLAB_KNOWN_HOSTS_FAILURE_COOLDOWN_MS = 30_000
const GLAB_KNOWN_HOSTS_CACHE_MAX_ENTRIES = 128
const knownHostsCacheByExecutionContext = new Map<string, readonly string[]>()
const knownHostsInFlightByExecutionContext = new Map<string, Promise<readonly string[]>>()
const knownHostsFailureByExecutionContext = new Map<
  string,
  { hosts: readonly string[]; retryAt: number }
>()
const rememberedHostsByLookupContext = new Map<string, readonly string[]>()

function rememberBounded<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > GLAB_KNOWN_HOSTS_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}

function knownHostsExecutionKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  return !connectionId && localGitOptions.wslDistro ? `wsl:${localGitOptions.wslDistro}` : 'native'
}

function knownHostsLookupKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  if (connectionId) {
    // Why: a reconnect can expose different repository hosts under the same connection id.
    return `connection:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
  }
  return knownHostsExecutionKey(connectionId, localGitOptions)
}

function mergeHosts(...groups: readonly (readonly string[])[]): readonly string[] {
  const hosts = new Set<string>()
  for (const group of groups) {
    for (const host of group) {
      const normalizedHost = normalizeGitLabHost(host)
      if (normalizedHost) {
        hosts.add(normalizedHost)
      }
    }
  }
  return Array.from(hosts)
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCacheByExecutionContext.clear()
  knownHostsInFlightByExecutionContext.clear()
  knownHostsFailureByExecutionContext.clear()
  rememberedHostsByLookupContext.clear()
}

export function rememberGlabKnownHost(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  rememberGlabKnownHosts([host], connectionId, localGitOptions)
}

export function rememberGlabKnownHosts(
  hosts: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const normalizedHosts = mergeHosts(hosts)
  if (normalizedHosts.length === 0) {
    return
  }
  if (connectionId) {
    const lookupKey = knownHostsLookupKey(connectionId, localGitOptions)
    const remembered = rememberedHostsByLookupContext.get(lookupKey) ?? []
    rememberBounded(
      rememberedHostsByLookupContext,
      lookupKey,
      mergeHosts(remembered, normalizedHosts)
    )
    return
  }
  const executionKey = knownHostsExecutionKey(connectionId, localGitOptions)
  const cached = knownHostsCacheByExecutionContext.get(executionKey) ?? DEFAULT_GITLAB_HOSTS
  knownHostsFailureByExecutionContext.delete(executionKey)
  rememberBounded(
    knownHostsCacheByExecutionContext,
    executionKey,
    mergeHosts(cached, normalizedHosts)
  )
}

export async function getGlabKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const executionKey = knownHostsExecutionKey(connectionId, localGitOptions)
  const lookupKey = knownHostsLookupKey(connectionId, localGitOptions)
  const remembered = (): readonly string[] => rememberedHostsByLookupContext.get(lookupKey) ?? []
  const cached = knownHostsCacheByExecutionContext.get(executionKey)
  if (cached) {
    rememberBounded(knownHostsCacheByExecutionContext, executionKey, cached)
    const lookupHosts = remembered()
    return lookupHosts.length === 0 ? cached : mergeHosts(cached, lookupHosts)
  }
  const failed = knownHostsFailureByExecutionContext.get(executionKey)
  if (failed) {
    if (Date.now() < failed.retryAt) {
      rememberBounded(knownHostsFailureByExecutionContext, executionKey, failed)
      return mergeHosts(failed.hosts, remembered())
    }
    knownHostsFailureByExecutionContext.delete(executionKey)
  }
  const inFlight = knownHostsInFlightByExecutionContext.get(executionKey)
  const probe = inFlight ?? probeGlabKnownHosts(executionKey, connectionId ? {} : localGitOptions)
  if (!inFlight) {
    knownHostsInFlightByExecutionContext.set(executionKey, probe)
  }
  try {
    const probedHosts = await probe
    const lookupHosts = remembered()
    return lookupHosts.length === 0 ? probedHosts : mergeHosts(probedHosts, lookupHosts)
  } finally {
    if (knownHostsInFlightByExecutionContext.get(executionKey) === probe) {
      knownHostsInFlightByExecutionContext.delete(executionKey)
    }
  }
}

async function probeGlabKnownHosts(
  key: string,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  try {
    // Why: SSH Git is remote, but glab runs beside Orca; share its probe with native lookups.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'], {
      timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
    })
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    const remembered = knownHostsCacheByExecutionContext.get(key) ?? []
    const merged = mergeHosts(DEFAULT_GITLAB_HOSTS, remembered, hosts)
    knownHostsFailureByExecutionContext.delete(key)
    rememberBounded(knownHostsCacheByExecutionContext, key, merged)
    return merged
  } catch {
    const cached = knownHostsCacheByExecutionContext.get(key)
    if (cached) {
      knownHostsFailureByExecutionContext.delete(key)
      return cached
    }
    const hosts = [...DEFAULT_GITLAB_HOSTS]
    // Why: one missing glab on an SSH/WSL host must not respawn on every card refresh; the short cooldown still discovers recovery.
    rememberBounded(knownHostsFailureByExecutionContext, key, {
      hosts,
      retryAt: Date.now() + GLAB_KNOWN_HOSTS_FAILURE_COOLDOWN_MS
    })
    return hosts
  }
}

export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set<string>()
  // Why: self-hosted GitLab can run on a non-default port; preserve it so
  // services on the same hostname remain distinct downstream.
  for (const match of output.matchAll(/logged in to ([a-zA-Z0-9.-]+(?::\d+)?)/gi)) {
    hosts.add(match[1].toLowerCase())
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
