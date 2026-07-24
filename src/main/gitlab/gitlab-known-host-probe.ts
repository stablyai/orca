import { glabExecFileAsync } from '../git/runner'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost } from './project-ref-parser'

export type LocalGitExecOptions = {
  wslDistro?: string
}

const GLAB_KNOWN_HOSTS_TIMEOUT_MS = 10_000
const knownHostsCacheByExecutionContext = new Map<string, readonly string[]>()
const knownHostsInFlightByExecutionContext = new Map<string, Promise<readonly string[]>>()

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
}

export function rememberGlabKnownHost(
  host: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): void {
  const normalizedHost = normalizeGitLabHost(host)
  const key = knownHostsExecutionKey(connectionId, localGitOptions)
  const cached = knownHostsCacheByExecutionContext.get(key)
  if (!cached || cached.map(normalizeGitLabHost).includes(normalizedHost)) {
    return
  }
  knownHostsCacheByExecutionContext.set(key, [...cached, normalizedHost])
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
  const inFlight = knownHostsInFlightByExecutionContext.get(key)
  if (inFlight) {
    return inFlight
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
      ...(!connectionId && localGitOptions.wslDistro
        ? { wslDistro: localGitOptions.wslDistro }
        : {})
    })
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    const merged = Array.from(new Set([...DEFAULT_GITLAB_HOSTS, ...hosts]))
    knownHostsCacheByExecutionContext.set(key, merged)
    return merged
  } catch {
    // Keep failures uncached so auth or tunnel recovery is discovered later.
    return [...DEFAULT_GITLAB_HOSTS]
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
