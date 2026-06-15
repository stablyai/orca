import type { GitHubOwnerRepo } from '../../shared/types'

// Why: alias the shared shape so `src/shared/types.ts#GitHubOwnerRepo` remains
// the single source of truth while main-side call sites can keep using the
// short local name `OwnerRepo`.
export type OwnerRepo = GitHubOwnerRepo

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }

export function parseGitHubOwnerRepo(remoteUrl: string): OwnerRepo | null {
  const identity = parseGitHubRemoteIdentity(remoteUrl)
  if (!identity || identity.host.toLowerCase() !== 'github.com') {
    return null
  }
  return { owner: identity.owner, repo: identity.repo }
}

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

export function normalizeGitHubApiHost(host: string): string | null {
  const normalized = host.trim().toLowerCase()
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(normalized)) {
    return null
  }
  const hostname = normalized.split(':')[0]
  // Why: ProjectV2 is GitHub-only. Do not reinterpret obvious non-GitHub
  // remotes as GitHub Enterprise just because they have owner/repo-shaped URLs.
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

export function preferredGitHubApiHost(host: string): boolean {
  const hostname = host.split(':')[0]
  return hostname === 'github.com' || hostname.includes('github') || hostname.includes('ghe')
}
