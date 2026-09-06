import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { glabExecFileAsync } from '../git/runner'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const GLAB_KNOWN_HOSTS_TIMEOUT_MS = 10_000
const UNAUTHENTICATED_HOSTS_MAX_ENTRIES = 128
const knownHostsCacheByExecutionContext = new Map<string, readonly string[]>()
const knownHostsInFlightByExecutionContext: CoalescedProbes<readonly string[]> = new Map()
const unauthenticatedHostExpiries = new Map<string, number>()

function knownHostsExecutionKey(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  if (connectionId) {
    // Why: reconnecting can replace the SSH/relay execution host under the same id.
    return `connection:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
  }
  return localGitOptions.wslDistro ? `wsl:${localGitOptions.wslDistro}` : 'native'
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCacheByExecutionContext.clear()
  knownHostsInFlightByExecutionContext.clear()
  unauthenticatedHostExpiries.clear()
}

/** @internal - exposed for tests only */
export function _resetGlabUnauthenticatedHosts(): void {
  unauthenticatedHostExpiries.clear()
}

function unauthenticatedHostKey(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): string {
  return `${knownHostsExecutionKey(connectionId, localGitOptions)}\0${normalizeGitLabHost(host)}`
}

/**
 * Why: `glab auth status --hostname` is how a self-hosted instance that plain
 * `glab auth status` did not list gets discovered, so a remote that is not
 * GitLab at all runs it too. Project-ref negatives expire now, and without this
 * that becomes one `glab` spawn per repo per interval on the hosted-review poll.
 * The answer is per host, not per repo, and expires on the same clock so a
 * login still lands within an interval.
 */
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

export function rememberGlabKnownHosts(
  hosts: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
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
    return
  }
  knownHostsCacheByExecutionContext.set(key, [...cached, ...additions])
}

export async function getGlabKnownHosts(
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<readonly string[]> {
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  const cached = knownHostsCacheByExecutionContext.get(key)
  if (cached) {
    return cached
  }
  // Why: only join a probe still young enough to answer, so a wedged one cannot
  // pin every later retry for the life of the process (P1-D).
  return runCoalescedProbe(knownHostsInFlightByExecutionContext, key, () =>
    probeGlabKnownHosts(key, connectionId, localGitOptions)
  )
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
      // Why: a local probe would cache the default distro's auth under 'native'
      // and wake an idle VM. A connection-keyed probe keeps the retry — glab never
      // runs over SSH/relay, so the calls it gates take that same fallback.
      ...(connectionId ? {} : { allowDefaultWslFallback: false }),
      ...(!connectionId && localGitOptions.wslDistro
        ? { wslDistro: localGitOptions.wslDistro }
        : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    const remembered = knownHostsCacheByExecutionContext.get(key) ?? []
    const merged = Array.from(new Set([...DEFAULT_GITLAB_HOSTS, ...remembered, ...hosts]))
    knownHostsCacheByExecutionContext.set(key, merged)
    return merged
  } catch {
    // Keep failures uncached so auth or tunnel recovery is discovered later.
    return knownHostsCacheByExecutionContext.get(key) ?? [...DEFAULT_GITLAB_HOSTS]
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
