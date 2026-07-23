import type { GitHubOwnerRepo } from '../../shared/types'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }
export const GITHUB_REMOTE_URL_MAX_BYTES = 64 * 1024
export const GITHUB_REMOTE_HOST_MAX_BYTES = 1024
export const GITHUB_REMOTE_OWNER_MAX_BYTES = 256
export const GITHUB_REMOTE_REPO_MAX_BYTES = 1024

function fitsRemoteField(value: string, maxBytes: number): boolean {
  return !measureUtf8ByteLength(value, { stopAfterBytes: maxBytes }).exceededLimit
}

function normalizeGitHubRemoteHost(host: string): string {
  const normalizedHost = host.toLowerCase()
  // Why: GitHub documents ssh.github.com as SSH-over-HTTPS for github.com repos.
  return normalizedHost === 'ssh.github.com' ? 'github.com' : normalizedHost
}

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
  if (
    !owner ||
    !repo ||
    !fitsRemoteField(owner, GITHUB_REMOTE_OWNER_MAX_BYTES) ||
    !fitsRemoteField(repo, GITHUB_REMOTE_REPO_MAX_BYTES)
  ) {
    return null
  }
  return { owner, repo }
}

export function parseGitHubRemoteIdentity(remoteUrl: string): GitHubRemoteIdentity | null {
  if (!fitsRemoteField(remoteUrl, GITHUB_REMOTE_URL_MAX_BYTES)) {
    return null
  }
  const trimmed = remoteUrl.trim()
  const sshMatch = trimmed.match(/^git@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i)
  if (sshMatch) {
    if (
      !fitsRemoteField(sshMatch[1], GITHUB_REMOTE_HOST_MAX_BYTES) ||
      !fitsRemoteField(sshMatch[2], GITHUB_REMOTE_OWNER_MAX_BYTES) ||
      !fitsRemoteField(sshMatch[3], GITHUB_REMOTE_REPO_MAX_BYTES)
    ) {
      return null
    }
    return { host: normalizeGitHubRemoteHost(sshMatch[1]), owner: sshMatch[2], repo: sshMatch[3] }
  }

  try {
    const url = new URL(trimmed)
    if (!['git:', 'git+ssh:', 'http:', 'https:', 'ssh:'].includes(url.protocol.toLowerCase())) {
      return null
    }
    const path = parseGitHubRemotePath(url.pathname)
    const host = normalizeGitHubRemoteHost(hostFromRemoteUrl(url))
    return path && fitsRemoteField(host, GITHUB_REMOTE_HOST_MAX_BYTES) ? { host, ...path } : null
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
