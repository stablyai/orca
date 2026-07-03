import { glabExecFileAsync } from '../git/runner'
import { DEFAULT_GITLAB_HOSTS, normalizeGitLabHost, type ProjectRef } from './project-ref-parser'

let knownHostsCache: readonly string[] | null = null

export function rememberGlabKnownHost(host: string): void {
  const normalizedHost = normalizeGitLabHost(host)
  if (!knownHostsCache || knownHostsCache.map(normalizeGitLabHost).includes(normalizedHost)) {
    return
  }
  knownHostsCache = [...knownHostsCache, normalizedHost]
}

export async function isGlabConfiguredForRemoteHost(
  repoPath: string,
  projectRef: Pick<ProjectRef, 'host'>,
  connectionId?: string | null
): Promise<boolean> {
  try {
    const result = await glabExecFileAsync(
      ['auth', 'status', '--hostname', projectRef.host],
      connectionId ? {} : { cwd: repoPath }
    )
    return result !== undefined
  } catch (error) {
    const execLike = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const output =
      [execLike.stdout, execLike.stderr, execLike.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n') || String(error)
    const hosts = parseGlabAuthStatusHosts(output).map(normalizeGitLabHost)
    return hosts.includes(normalizeGitLabHost(projectRef.host))
  }
}

/** @internal - exposed for tests only */
export function _resetKnownHostsCache(): void {
  knownHostsCache = null
}

export async function getGlabKnownHosts(): Promise<readonly string[]> {
  if (knownHostsCache) {
    return knownHostsCache
  }
  try {
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'])
    // Why: glab writes auth status to stderr in some versions, stdout in
    // others. Concatenate so the parser sees both.
    const hosts = parseGlabAuthStatusHosts(`${stdout}\n${stderr}`)
    // Always include gitlab.com so a fresh-install user with no auth
    // still recognizes the canonical host.
    const merged = Array.from(new Set([...DEFAULT_GITLAB_HOSTS, ...hosts]))
    knownHostsCache = merged
    return merged
  } catch {
    // Auth check failed (glab not installed, no auth, etc.) - fall back
    // to the canonical default. The caller will hit the auth error on
    // the first real request anyway.
    knownHostsCache = [...DEFAULT_GITLAB_HOSTS]
    return knownHostsCache
  }
}

// Why: glab auth status output is human-formatted and varies across versions.
// Match observed logged-in lines and host headers, dedupe, lowercase.
export function parseGlabAuthStatusHosts(output: string): string[] {
  const hosts = new Set<string>()
  for (const m of output.matchAll(/logged in to ([a-zA-Z0-9.-]+)/gi)) {
    hosts.add(m[1].toLowerCase())
  }
  for (const line of output.split('\n')) {
    const bareLine = line.trim()
    const hostLine = bareLine.endsWith(':') ? bareLine.slice(0, -1) : bareLine
    if (line === bareLine && /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(hostLine)) {
      hosts.add(hostLine.toLowerCase())
    }
  }
  return Array.from(hosts)
}
