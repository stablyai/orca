import type { GitLabProjectRef } from '../../shared/types'

export type ProjectRef = GitLabProjectRef

/**
 * Hosts always treated as GitLab. Self-hosted instances are added at
 * runtime via `getGlabKnownHosts()`, which inspects `glab auth status`.
 */
export const DEFAULT_GITLAB_HOSTS = ['gitlab.com'] as const

export function normalizeGitLabHost(value: string): string {
  return value.trim().toLowerCase()
}

// Why: host recognition is port-aware so two services on the same hostname
// but different ports (e.g. a GitLab on :8080 and a Gitea on :3030) are not
// conflated. The hostname (port-less) part is kept for legacy known-host
// entries that were recorded without a port.
function hostnameOf(host: string): string {
  // `host` may be `name` or `name:port`. Strip a trailing `:digits` port.
  return host.replace(/:\d+$/, '')
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
}

// Why: the GitLab host identity is the web/API endpoint, which is what `glab
// --hostname` and the known-hosts list speak in terms of. For http(s)
// remotes the URL port IS that endpoint port (e.g. self-hosted on :8080),
// so it must be kept. For ssh/git remotes the port is a transport port
// (e.g. ssh on :2222) that does not identify the GitLab instance, so it is
// dropped and only the hostname is used.
function hostIdentityFromUrl(url: URL): string {
  const protocol = url.protocol.toLowerCase()
  if (protocol === 'http:' || protocol === 'https:') {
    return url.host
  }
  return url.hostname
}

function makeProjectRefForTrustedHost(host: string, path: string): ProjectRef | null {
  const normalizedHost = normalizeGitLabHost(host)
  const normalizedPath = stripGitSuffix(path.replace(/^\/+/, '')).trim()
  // Reject paths without at least one group segment — `gitlab.com:foo`
  // alone is not a project reference.
  if (!normalizedPath.includes('/')) {
    return null
  }
  return { host: normalizedHost, path: normalizedPath }
}

/**
 * Does `urlHost` (which may include a `:port`) match a known-host entry?
 * - An exact match (including any port) always counts.
 * - A known entry WITHOUT a port also matches a URL host on the same
 *   hostname regardless of the URL's port — this preserves recognition for
 *   legacy `gitlab.com` / bare-hostname known entries.
 * - A known entry WITH a port only matches a URL host with the exact same
 *   port, so `gitlab.example.com:8443` does not accept a
 *   `gitea.example.com:3000` (or same-host different-port) remote.
 */
function knownHostMatches(urlHost: string, knownHost: string): boolean {
  if (urlHost === knownHost) {
    return true
  }
  if (hostnameOf(knownHost) === knownHost) {
    // Known entry has no port — match on hostname alone.
    return hostnameOf(urlHost) === knownHost
  }
  return false
}

function makeProjectRef(
  host: string,
  path: string,
  knownHosts: readonly string[]
): ProjectRef | null {
  const normalizedHost = normalizeGitLabHost(host)
  const normalizedKnownHosts = knownHosts.map(normalizeGitLabHost)
  if (!normalizedKnownHosts.some((knownHost) => knownHostMatches(normalizedHost, knownHost))) {
    return null
  }
  return makeProjectRefForTrustedHost(normalizedHost, path)
}

export function parseRemoteProjectRefCandidate(remoteUrl: string): ProjectRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      return makeProjectRefForTrustedHost(scpLike[1], scpLike[2])
    }
  }

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    return makeProjectRefForTrustedHost(hostIdentityFromUrl(url), url.pathname)
  } catch {
    return null
  }
}

export function parseGitLabProjectRef(
  remoteUrl: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS
): ProjectRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      return makeProjectRef(scpLike[1], scpLike[2], knownHosts)
    }
  }

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    return makeProjectRef(hostIdentityFromUrl(url), url.pathname, knownHosts)
  } catch {
    return null
  }
}
