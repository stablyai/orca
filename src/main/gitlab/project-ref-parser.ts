import type { GitLabProjectRef } from '../../shared/gitlab-types'

export type ProjectRef = GitLabProjectRef
export const DEFAULT_GITLAB_HOSTS = ['gitlab.com'] as const

export function normalizeGitLabHost(value: string): string {
  return value.trim().toLowerCase()
}

// Why: host recognition is port-aware so two services on the same hostname
// but different ports (e.g. a GitLab on :8080 and a Gitea on :3030) are not
// conflated. The hostname (port-less) part is kept so port-less ssh remotes
// can still be mapped onto a configured host that carries a port.
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
 * Resolve a remote's host+path against the known hosts. Host recognition is
 * exact: a configured `gitlab.example.com` and a remote on
 * `gitlab.example.com:3030` are different endpoints, and routing the latter
 * through `glab --hostname` would target an instance the user never
 * configured.
 */
function makeProjectRef(
  host: string,
  path: string,
  knownHosts: readonly string[],
  allowConfiguredPortMapping = false
): ProjectRef | null {
  const normalizedHost = normalizeGitLabHost(host)
  const normalizedKnownHosts = knownHosts.map(normalizeGitLabHost)
  if (normalizedKnownHosts.includes(normalizedHost)) {
    return makeProjectRefForTrustedHost(normalizedHost, path)
  }
  // Why: ssh/scp remotes carry no web port, so they can never match a single
  // configured host that has one. Map them onto it by hostname instead.
  const configuredHost = normalizedKnownHosts.length === 1 ? normalizedKnownHosts[0] : null
  if (
    allowConfiguredPortMapping &&
    configuredHost &&
    hostnameOf(configuredHost) === normalizedHost
  ) {
    return makeProjectRefForTrustedHost(configuredHost, path)
  }
  return null
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
      return makeProjectRef(scpLike[1], scpLike[2], knownHosts, true)
    }
  }

  try {
    const url = new URL(trimmed)
    if (!['http:', 'https:', 'ssh:', 'git:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const protocol = url.protocol.toLowerCase()
    return makeProjectRef(
      hostIdentityFromUrl(url),
      url.pathname,
      knownHosts,
      protocol !== 'http:' && protocol !== 'https:'
    )
  } catch {
    return null
  }
}
