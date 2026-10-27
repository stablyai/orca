import { stripAnsiEscapeSequences } from '../../shared/ansi-escape-sequences'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { extractExecError } from '../git/exec-error'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { glabExecFileAsync } from '../git/runner'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const GLAB_KNOWN_HOSTS_TIMEOUT_MS = 10_000
const UNAUTHENTICATED_HOSTS_MAX_ENTRIES = 128
export const KNOWN_HOSTS_CACHE_MAX_ENTRIES = 128
export const KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS = 15_000
const knownHostsCacheByExecutionContext = new Map<string, readonly string[]>()
// Failed probes back off exponentially (capped) so locked keyrings are not re-prompted on every poll.
const knownHostsFailureBackoff = new Map<
  string,
  { retryAt: number; delayMs: number; hosts: readonly string[] }
>()
const knownHostsInFlightByExecutionContext: CoalescedProbes<readonly string[]> = new Map()
const unauthenticatedHostExpiries = new Map<string, number>()

function knownHostsExecutionKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  if (connectionId) {
    return `connection:${connectionId}`
  }
  return localGitOptions.wslDistro ? `wsl:${localGitOptions.wslDistro}` : 'native'
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCacheByExecutionContext.clear()
  knownHostsInFlightByExecutionContext.clear()
  knownHostsFailureBackoff.clear()
  unauthenticatedHostExpiries.clear()
}

/** @internal - exposed for tests only */
export function _resetGlabUnauthenticatedHosts(): void {
  unauthenticatedHostExpiries.clear()
}

/** @internal - exposed for cache-bound tests only. */
export function _getKnownHostsCacheSize(): number {
  return knownHostsCacheByExecutionContext.size
}

function trimKnownHostsCache(): void {
  while (knownHostsCacheByExecutionContext.size > KNOWN_HOSTS_CACHE_MAX_ENTRIES) {
    const oldest = knownHostsCacheByExecutionContext.keys().next()
    if (oldest.done) {
      break
    }
    knownHostsCacheByExecutionContext.delete(oldest.value)
  }
}

function unauthenticatedHostKey(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  return `${knownHostsExecutionKey(connectionId, localGitOptions)}\0${normalizeGitLabHost(host)}`
}

/** Share negative host-auth probes across repositories until expiry, avoiding a subprocess per repo on each poll. */
export function isGlabHostKnownUnauthenticated(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): boolean {
  const key = unauthenticatedHostKey(host, connectionId, localGitOptions)
  const expiresAt = unauthenticatedHostExpiries.get(key)
  if (expiresAt === undefined) {
    return false
  }
  if (expiresAt > Date.now()) {
    return true
  }
  unauthenticatedHostExpiries.delete(key)
  return false
}

export function rememberGlabHostUnauthenticated(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  unauthenticatedHostExpiries.set(
    unauthenticatedHostKey(host, connectionId, localGitOptions),
    Date.now() + NEGATIVE_ENTRY_TTL_MS
  )
  while (unauthenticatedHostExpiries.size > UNAUTHENTICATED_HOSTS_MAX_ENTRIES) {
    const oldestKey = unauthenticatedHostExpiries.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    unauthenticatedHostExpiries.delete(oldestKey)
  }
}

export function rememberGlabKnownHost(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  rememberGlabKnownHosts([host], connectionId, localGitOptions)
}

export function getGlabPartialHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): readonly string[] {
  return (
    knownHostsFailureBackoff.get(knownHostsExecutionKey(connectionId, localGitOptions))?.hosts ?? []
  )
}

export function rememberGlabKnownHosts(
  hosts: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  const partial = knownHostsFailureBackoff.get(key)
  knownHostsFailureBackoff.delete(key)
  const cached = knownHostsCacheByExecutionContext.get(key) ?? DEFAULT_GITLAB_HOSTS
  const seen = new Set(cached.map(normalizeGitLabHost))
  const additions: string[] = []
  for (const host of hosts) {
    const normalizedHost = normalizeGitLabHost(host)
    if (seen.has(normalizedHost)) {
      continue
    }
    seen.add(normalizedHost)
    additions.push(normalizedHost)
    unauthenticatedHostExpiries.delete(
      unauthenticatedHostKey(normalizedHost, connectionId, localGitOptions)
    )
  }
  if (additions.length === 0) {
    if (!knownHostsCacheByExecutionContext.has(key) && partial?.hosts.length) {
      knownHostsFailureBackoff.set(key, { hosts: partial.hosts, retryAt: 0, delayMs: 0 })
    }
    return
  }
  knownHostsCacheByExecutionContext.set(
    key,
    Array.from(new Set([...cached, ...additions, ...(partial?.hosts ?? [])]))
  )
  trimKnownHostsCache()
}

export async function getGlabKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  const cached = knownHostsCacheByExecutionContext.get(key)
  if (cached) {
    knownHostsCacheByExecutionContext.delete(key)
    knownHostsCacheByExecutionContext.set(key, cached)
    return cached
  }
  if ((knownHostsFailureBackoff.get(key)?.retryAt ?? 0) > Date.now()) {
    return [...DEFAULT_GITLAB_HOSTS]
  }
  // Retire wedged probes so later retries can discover recovered auth.
  return runCoalescedProbe(knownHostsInFlightByExecutionContext, key, (ownsKey) =>
    probeGlabKnownHosts(key, ownsKey, connectionId, localGitOptions)
  )
}

async function probeGlabKnownHosts(
  key: string,
  ownsKey: () => boolean,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  try {
    // Isolate native, WSL and connection probe state; bound each auth subprocess.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'], {
      timeout: GLAB_KNOWN_HOSTS_TIMEOUT_MS,
      // Native probes must not cache default-distro auth; connection-keyed API calls retain that same fallback.
      ...(connectionId ? {} : { allowDefaultWslFallback: false }),
      ...(!connectionId && localGitOptions.wslDistro
        ? { wslDistro: localGitOptions.wslDistro }
        : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    const remembered = knownHostsCacheByExecutionContext.get(key) ?? []
    const partial = knownHostsFailureBackoff.get(key)?.hosts ?? []
    const merged = Array.from(
      new Set([...DEFAULT_GITLAB_HOSTS, ...remembered, ...partial, ...hosts])
    )
    if (ownsKey()) {
      knownHostsFailureBackoff.delete(key)
      knownHostsCacheByExecutionContext.set(key, merged)
      trimKnownHostsCache()
    }
    return merged
  } catch (error) {
    if (ownsKey()) {
      const { stdout, stderr } = extractExecError(error)
      const hosts = isCompletedGlabFailure(error)
        ? parseGlabAuthenticatedHosts(`${stdout}\n${stderr}`)
        : []
      rememberKnownHostsFailure(key, hosts)
    }
    return knownHostsCacheByExecutionContext.get(key) ?? [...DEFAULT_GITLAB_HOSTS]
  }
}

function isCompletedGlabFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof error.code === 'number' &&
    error.code !== 0 &&
    'killed' in error &&
    error.killed === false &&
    'signal' in error &&
    error.signal === null &&
    'outputTruncated' in error &&
    error.outputTruncated === false &&
    error.name !== 'AbortError'
  )
}

function parseGlabAuthenticatedHosts(output: string): string[] {
  const hosts = new Set<string>()
  for (const match of stripAnsiEscapeSequences(output).matchAll(
    /^[\t ]*(?:\u2713[\t ]+)?Logged in to ([a-zA-Z0-9.-]+(?::\d+)?)[\t ]+as[\t ]+[^\s(]+/gim
  )) {
    hosts.add(match[1].toLowerCase())
  }
  return Array.from(hosts)
}

function rememberKnownHostsFailure(key: string, hosts: readonly string[]): void {
  const partial = knownHostsFailureBackoff.get(key)?.hosts ?? []
  const previousDelayMs = knownHostsFailureBackoff.get(key)?.delayMs
  const delayMs = previousDelayMs
    ? Math.min(previousDelayMs * 2, NEGATIVE_ENTRY_TTL_MS)
    : KNOWN_HOSTS_FAILURE_INITIAL_BACKOFF_MS
  knownHostsFailureBackoff.delete(key)
  knownHostsFailureBackoff.set(key, {
    retryAt: Date.now() + delayMs,
    delayMs,
    hosts: Array.from(new Set([...partial, ...hosts]))
  })
  while (knownHostsFailureBackoff.size > KNOWN_HOSTS_CACHE_MAX_ENTRIES) {
    const oldestKey = knownHostsFailureBackoff.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    knownHostsFailureBackoff.delete(oldestKey)
  }
}

export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set(parseGlabAuthenticatedHosts(output))
  // Preserve non-default web ports so same-host services retain distinct identity.
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
