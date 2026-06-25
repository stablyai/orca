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

function stripGitSuffix(path: string): string {
  return path.replace(/\/+$/, '').replace(/\.git$/i, '')
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

function makeProjectRef(
  host: string,
  path: string,
  knownHosts: readonly string[]
): ProjectRef | null {
  const normalizedHost = normalizeGitLabHost(host)
  const normalizedKnownHosts = knownHosts.map(normalizeGitLabHost)
  if (!normalizedKnownHosts.includes(normalizedHost)) {
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
    return makeProjectRefForTrustedHost(url.hostname, url.pathname)
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
    return makeProjectRef(url.hostname, url.pathname, knownHosts)
  } catch {
    return null
  }
}
