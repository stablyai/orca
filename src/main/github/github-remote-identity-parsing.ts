import type { GitHubOwnerRepo } from '../../shared/types'

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }

function normalizeGitHubRemoteHost(host: string): string {
  const normalizedHost = host.toLowerCase()
  // Why: GitHub documents ssh.github.com:443 as SSH-over-HTTPS for github.com repos.
  return normalizedHost === 'ssh.github.com' ? 'github.com' : normalizedHost
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
    return path ? { host: normalizeGitHubRemoteHost(url.hostname), ...path } : null
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

// Why (issue #1715): validate and normalize a git remote host into a `gh api
// --hostname` value. ProjectV2 is GitHub-only, so reject hosts that obviously
// belong to other providers rather than mis-routing them to a GHES API.
export function normalizeGitHubApiHost(host: string): string | null {
  const normalized = host.trim().toLowerCase()
  // Reject a leading dash so the host can never be mistaken for a gh CLI flag.
  if (!/^[a-z0-9]([a-z0-9.-]*)?(?::[0-9]+)?$/.test(normalized)) {
    return null
  }
  const hostname = normalized.split(':')[0]
  if (
    hostname === 'gitlab.com' ||
    hostname.endsWith('.gitlab.com') ||
    hostname === 'bitbucket.org' ||
    hostname.endsWith('.bitbucket.org') ||
    hostname === 'dev.azure.com' ||
    hostname.endsWith('.visualstudio.com')
  ) {
    return null
  }
  return normalized
}

// Why (issue #1715): a heuristic for which remote host most likely hosts the
// GitHub API. github.com is canonical; otherwise a host containing "github" or
// "ghe" is almost certainly a GitHub Enterprise instance and is preferred over
// an unrecognized host (which is only used as a fallback).
export function preferredGitHubApiHost(host: string): boolean {
  const hostname = host.split(':')[0]
  return hostname === 'github.com' || hostname.includes('github') || hostname.includes('ghe')
}
