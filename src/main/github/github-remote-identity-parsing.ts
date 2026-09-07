import { normalizeGitHubRemoteHost } from '../../shared/git-remote-host-alias'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }

// Why: HTTP ports identify the GHES web/API endpoint; SSH and git ports are
// transport-only and must not leak into gh's host identity.
function hostFromRemoteUrl(url: URL): string {
  const protocol = url.protocol.toLowerCase()
  return protocol === 'http:' || protocol === 'https:' ? url.host : url.hostname
}

function parseGitHubRemotePath(path: string): Pick<GitHubRemoteIdentity, 'owner' | 'repo'> | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length !== 2) {
    return null
  }
  const [owner, repoWithSuffix] = parts
  const repo = repoWithSuffix.replace(/\.git$/i, '')
  if (!owner || !repo) {
    return null
  }
  return { owner, repo }
}

/** SCP-style / ssh:// / git+ssh:// remotes may use an OpenSSH Host alias. */
export function remoteUrlUsesSshTransport(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim().toLowerCase()
  return (
    trimmed.startsWith('git@') || trimmed.startsWith('ssh://') || trimmed.startsWith('git+ssh://')
  )
}

/** SSH transport host as written, preserving SCP alias case. */
export function rawSshTransportHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim()
  const scpMatch = trimmed.match(/^git@([^:]+):/i)
  if (scpMatch) {
    return scpMatch[1]
  }
  try {
    const url = new URL(trimmed)
    if (!['ssh:', 'git+ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    return url.hostname || null
  } catch {
    return null
  }
}

/** Non-GitHub SSH host that may need OpenSSH alias expansion. */
export function gitHubSshConfigHostAlias(remoteUrl: string): string | null {
  if (!remoteUrlUsesSshTransport(remoteUrl)) {
    return null
  }
  const identity = parseGitHubRemoteIdentity(remoteUrl)
  if (!identity || identity.host === 'github.com') {
    return null
  }
  return rawSshTransportHost(remoteUrl) ?? identity.host
}

export function parseGitHubRemoteIdentity(remoteUrl: string): GitHubRemoteIdentity | null {
  const trimmed = remoteUrl.trim()
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) {
    return { host: normalizeGitHubRemoteHost(sshMatch[1]), owner: sshMatch[2], repo: sshMatch[3] }
  }

  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const path = parseGitHubRemotePath(url.pathname)
    return path ? { host: normalizeGitHubRemoteHost(hostFromRemoteUrl(url)), ...path } : null
  } catch {
    return null
  }
}

export function parseGitHubOwnerRepo(remoteUrl: string): GitHubOwnerRepo | null {
  const identity = parseGitHubRemoteIdentity(remoteUrl)
  if (!identity || identity.host.toLowerCase() !== 'github.com') {
    return null
  }
  return { owner: identity.owner, repo: identity.repo }
}

/** Parse github.com identity using an expanded SSH HostName. */
export function parseGitHubOwnerRepoWithResolvedSshHostname(
  remoteUrl: string,
  resolvedSshHostname: string | null | undefined
): GitHubOwnerRepo | null {
  const direct = parseGitHubOwnerRepo(remoteUrl)
  if (direct) {
    return direct
  }
  if (!remoteUrlUsesSshTransport(remoteUrl)) {
    return null
  }
  if (!resolvedSshHostname?.trim()) {
    return null
  }
  const identity = parseGitHubRemoteIdentity(remoteUrl)
  if (!identity) {
    return null
  }
  if (normalizeGitHubRemoteHost(resolvedSshHostname.trim()) !== 'github.com') {
    return null
  }
  return { owner: identity.owner, repo: identity.repo }
}

/** Effective forge host after optional SSH config HostName expansion. */
export function effectiveGitHubRemoteHost(
  parsedHost: string,
  resolvedSshHostname?: string | null
): string {
  const candidate = resolvedSshHostname?.trim() || parsedHost
  return normalizeGitHubRemoteHost(candidate)
}
