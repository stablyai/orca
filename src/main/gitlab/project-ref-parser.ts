import type { GitLabProjectRef } from '../../shared/gitlab-types'
import { normalizeGitLabRemoteHost } from '../../shared/git-remote-host-alias'

export type ProjectRef = GitLabProjectRef

/** Authenticated custom hosts extend the built-in GitLab host inventory at runtime. */
export const DEFAULT_GITLAB_HOSTS = ['gitlab.com'] as const

export function normalizeGitLabHost(value: string): string {
  return value.trim().toLowerCase()
}

function hostnameOf(host: string): string {
  return host.replace(/:\d+$/, '')
}

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
}

// HTTP ports identify API endpoints; SSH/git ports are transport-only.
function hostIdentityFromUrl(url: URL): string {
  const protocol = url.protocol.toLowerCase()
  if (protocol === 'http:' || protocol === 'https:') {
    return url.host
  }
  return url.hostname
}

function makeProjectRefForTrustedHost(host: string, path: string): ProjectRef | null {
  const normalizedHost = normalizeGitLabRemoteHost(host)
  const normalizedPath = stripGitSuffix(path.replace(/^\/+/, '')).trim()
  if (!normalizedPath.includes('/')) {
    return null
  }
  return { host: normalizedHost, path: normalizedPath }
}

/** Match ports exactly unless the known-host entry is legacy/portless, which matches any port on that hostname. */
function knownHostMatches(urlHost: string, knownHost: string): boolean {
  if (urlHost === knownHost) {
    return true
  }
  if (hostnameOf(knownHost) === knownHost) {
    return hostnameOf(urlHost) === knownHost
  }
  return false
}

function makeProjectRef(
  host: string,
  path: string,
  knownHosts: readonly string[]
): ProjectRef | null {
  const normalizedHost = normalizeGitLabRemoteHost(host)
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
