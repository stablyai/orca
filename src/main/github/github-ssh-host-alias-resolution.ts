import type { GitHubOwnerRepo } from '../../shared/types'
import { commandExecFileAsync } from '../git/runner'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { parseWslPath } from '../wsl'
import { resolveWithSshG } from '../ssh/ssh-g-config-resolution'
import {
  gitHubSshConfigHostAlias,
  parseGitHubOwnerRepo,
  parseGitHubOwnerRepoWithResolvedSshHostname
} from './github-remote-identity-parsing'

/** `indeterminate` means SSH alias expansion failed and must remain retryable. */
export type GitHubOwnerRepoResolution =
  | { kind: 'github'; ownerRepo: GitHubOwnerRepo }
  | { kind: 'not-github'; cacheWithGitConfigSignature: boolean }
  | { kind: 'indeterminate' }

const SSH_HOSTNAME_CACHE_TTL_MS = 60_000
const SSH_HOSTNAME_FAILURE_CACHE_TTL_MS = 5_000
const SSH_HOSTNAME_CACHE_MAX = 256
const SSH_G_TIMEOUT_MS = 5_000

export type SshConfigResolutionContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
}

type SshHostnameCacheEntry = {
  hostname: string | null
  resolved: boolean
  expiresAt: number
}

const sshHostnameCache = new Map<string, SshHostnameCacheEntry>()
const sshHostnameInFlight = new Map<string, Promise<SshHostnameCacheEntry>>()

/** @internal - tests only */
export function _resetSshHostnameResolutionCache(): void {
  sshHostnameCache.clear()
  sshHostnameInFlight.clear()
}

function pruneSshHostnameCache(now: number): void {
  for (const [key, entry] of sshHostnameCache) {
    if (entry.expiresAt <= now) {
      sshHostnameCache.delete(key)
    }
  }
  while (sshHostnameCache.size > SSH_HOSTNAME_CACHE_MAX) {
    const oldest = sshHostnameCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    sshHostnameCache.delete(oldest)
  }
}

function sshRuntimeCacheKey(context: SshConfigResolutionContext): string {
  if (context.connectionId) {
    const generation = getSshGitProviderGeneration(context.connectionId)
    return `ssh:${context.connectionId}:${generation}`
  }
  const distro = context.wslDistro ?? parseWslPath(context.repoPath)?.distro
  return `local:${distro?.toLowerCase() ?? 'host'}`
}

function parseSshGHostname(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^hostname\s+(.+)$/i)
    if (match?.[1].trim()) {
      return match[1].trim()
    }
  }
  return null
}

async function resolveSshHostnameInRuntime(
  host: string,
  context: SshConfigResolutionContext
): Promise<string | null> {
  if (context.connectionId) {
    const provider = getSshGitProvider(context.connectionId)
    if (!provider) {
      return null
    }
    try {
      const result = await provider.execNonInteractive(
        'ssh',
        ['-G', '--', host],
        context.repoPath,
        SSH_G_TIMEOUT_MS
      )
      return result.exitCode === 0 && !result.timedOut && !result.canceled
        ? parseSshGHostname(result.stdout)
        : null
    } catch {
      return null
    }
  }

  const wslDistro = context.wslDistro ?? parseWslPath(context.repoPath)?.distro
  if (!wslDistro) {
    return (await resolveWithSshG(host))?.hostname?.trim() || null
  }
  try {
    const { stdout } = await commandExecFileAsync('ssh', ['-G', '--', host], {
      cwd: context.repoPath,
      timeout: SSH_G_TIMEOUT_MS,
      wslDistro
    })
    return parseSshGHostname(stdout)
  } catch {
    return null
  }
}

/** Resolve OpenSSH Host → HostName in the repository runtime. */
export async function resolveSshConfigHostname(
  host: string,
  context: SshConfigResolutionContext = { repoPath: '' }
): Promise<{
  hostname: string | null
  resolved: boolean
}> {
  const cacheKey = `${sshRuntimeCacheKey(context)}\0${host}`
  const now = Date.now()
  pruneSshHostnameCache(now)
  const cached = sshHostnameCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return { hostname: cached.hostname, resolved: cached.resolved }
  }
  const inFlight = sshHostnameInFlight.get(cacheKey)
  if (inFlight) {
    const entry = await inFlight
    return { hostname: entry.hostname, resolved: entry.resolved }
  }
  const probe = (async (): Promise<SshHostnameCacheEntry> => {
    const hostname = await resolveSshHostnameInRuntime(host, context)
    const resolved = hostname != null && hostname.length > 0
    const entry: SshHostnameCacheEntry = {
      hostname: resolved ? hostname : null,
      resolved,
      expiresAt:
        Date.now() + (resolved ? SSH_HOSTNAME_CACHE_TTL_MS : SSH_HOSTNAME_FAILURE_CACHE_TTL_MS)
    }
    sshHostnameCache.set(cacheKey, entry)
    pruneSshHostnameCache(Date.now())
    return entry
  })()
  sshHostnameInFlight.set(cacheKey, probe)
  try {
    const entry = await probe
    return { hostname: entry.hostname, resolved: entry.resolved }
  } finally {
    if (sshHostnameInFlight.get(cacheKey) === probe) {
      sshHostnameInFlight.delete(cacheKey)
    }
  }
}

/** Resolve github.com identity without rewriting the Git transport URL. */
export async function classifyGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string,
  context: SshConfigResolutionContext = { repoPath: '' }
): Promise<GitHubOwnerRepoResolution> {
  const direct = parseGitHubOwnerRepo(remoteUrl)
  if (direct) {
    return { kind: 'github', ownerRepo: direct }
  }
  const aliasHost = gitHubSshConfigHostAlias(remoteUrl)
  if (!aliasHost) {
    return { kind: 'not-github', cacheWithGitConfigSignature: true }
  }
  const { hostname, resolved } = await resolveSshConfigHostname(aliasHost, context)
  if (!resolved || !hostname) {
    return { kind: 'indeterminate' }
  }
  const ownerRepo = parseGitHubOwnerRepoWithResolvedSshHostname(remoteUrl, hostname)
  return ownerRepo
    ? { kind: 'github', ownerRepo }
    : { kind: 'not-github', cacheWithGitConfigSignature: false }
}

/** Convenience wrapper for callers that only need owner/repo or null. */
export async function resolveGitHubOwnerRepoFromRemoteUrl(
  remoteUrl: string,
  context: SshConfigResolutionContext = { repoPath: '' }
): Promise<GitHubOwnerRepo | null> {
  const result = await classifyGitHubOwnerRepoFromRemoteUrl(remoteUrl, context)
  return result.kind === 'github' ? result.ownerRepo : null
}
