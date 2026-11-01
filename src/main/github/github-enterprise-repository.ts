import { githubReadExecutionScope } from './github-read-execution-scope'
import { ghExecFileAsync } from '../git/runner'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../source-control/hosted-review-git-options'
import { parseAuthStatus } from './auth-diagnose'
import {
  ghRepoExecOptions,
  getRemoteUrlForRepo,
  githubRepoContext,
  parseGitHubRemoteIdentity,
  type LocalGitExecOptions
} from './github-repository-identity'
import {
  effectiveGitHubRemoteHost,
  gitHubSshConfigHostAlias
} from './github-remote-identity-parsing'
import { resolveSshConfigHostname } from './github-ssh-host-alias-resolution'
import { parseWslPath } from '../wsl'
import { isStableMissingGitRemoteError } from '../git/stable-missing-git-remote-error'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../shared/execution-host'

export type GitHubEnterpriseRepoSlug = GitHubOwnerRepo & { host: string }

// Authenticated gh inventory identifies GitHub Enterprise hosts without claiming another forge's remote.
const HOST_AUTH_TTL_MS = 15 * 60_000
const HOST_AUTH_MISS_TTL_MS = 60_000
const HOST_AUTH_CACHE_MAX_ENTRIES = 512

type HostAuthCacheEntry = {
  authenticatedHost: string | null
  expiresAt: number
}

const hostAuthCache = new Map<string, HostAuthCacheEntry>()
const hostAuthInFlight = new Map<string, Promise<string | null | undefined>>()

// Key connection-backed auth separately from same-path local repositories, even though gh runs locally.
function runtimeCacheKey(
  repoPath: string,
  connectionId?: string | null,
  wslDistro?: string
): string {
  if (connectionId) {
    return `connection:${connectionId}`
  }
  const resolvedDistro = wslDistro ?? parseWslPath(repoPath)?.distro
  return `local:${resolvedDistro?.toLowerCase() ?? 'host'}`
}

/** @internal - exposed for tests only */
export function _resetGitHubHostAuthCache(): void {
  hostAuthCache.clear()
  hostAuthInFlight.clear()
}

function pruneHostAuthCache(now: number): void {
  for (const [key, entry] of hostAuthCache) {
    if (entry.expiresAt <= now) {
      hostAuthCache.delete(key)
    }
  }
  while (hostAuthCache.size > HOST_AUTH_CACHE_MAX_ENTRIES) {
    const oldestKey = hostAuthCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    hostAuthCache.delete(oldestKey)
  }
}

// Only command streams are authoritative; message-only spawn failures leave auth indeterminate.
function ghCommandOutput(error: unknown): string {
  const execErr = error as { stdout?: unknown; stderr?: unknown }
  return [execErr?.stdout, execErr?.stderr]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
}

type NormalizedGitHubHost = {
  hostname: string
  port: string | null
  authority: string
}

function normalizeGitHubHost(host: string): NormalizedGitHubHost | null {
  const match = host
    .trim()
    .toLowerCase()
    .match(/^([a-z0-9][a-z0-9.-]*)(?::(\d+))?$/i)
  if (!match) {
    return null
  }
  const hostname = match[1]
  // URL parsing already stripped default ports; remaining ports identify the API endpoint.
  const port = match[2] ?? null
  return { hostname, port, authority: port ? `${hostname}:${port}` : hostname }
}

function authenticatedHostFromInventory(host: string, output: string): string | null {
  const requested = normalizeGitHubHost(host)
  if (!requested) {
    return null
  }
  const inventory = Array.from(
    new Map(
      parseAuthStatus(output)
        .map((account) => normalizeGitHubHost(account.host))
        .filter((candidate): candidate is NormalizedGitHubHost => candidate !== null)
        .map((candidate) => [candidate.authority, candidate])
    ).values()
  )
  const exact = inventory.find((candidate) => candidate.authority === requested.authority)
  if (exact) {
    return exact.authority
  }
  if (requested.port) {
    return null
  }
  const compatible = inventory.filter((candidate) => candidate.hostname === requested.hostname)
  // SSH omits the API port; infer one only from an unambiguous authenticated endpoint.
  return compatible.length === 1 ? compatible[0].authority : null
}

async function resolveAuthenticatedGitHubHost(
  host: string,
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null | undefined> {
  const normalizedHost = normalizeGitHubHost(host)?.authority ?? host.trim().toLowerCase()
  const execOptions = ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
  const cacheKey = `${runtimeCacheKey(repoPath, connectionId, localGitOptions.wslDistro)}\0${normalizedHost}\0${githubReadExecutionScope(execOptions)}`
  const now = Date.now()
  pruneHostAuthCache(now)
  const cached = hostAuthCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.authenticatedHost
  }
  const inFlight = hostAuthInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    let authenticatedHost: string | null
    try {
      const { stdout, stderr } = await ghExecFileAsync(['auth', 'status'], execOptions)
      authenticatedHost = authenticatedHostFromInventory(host, `${stdout}\n${stderr}`)
    } catch (error) {
      const output = ghCommandOutput(error)
      if (!output) {
        // Leave spawn failures uncached so installation or credential changes can recover.
        return undefined
      }
      // Nonzero auth status may still list hosts with token problems; inspect the inventory.
      authenticatedHost = authenticatedHostFromInventory(host, output)
    }
    hostAuthCache.set(cacheKey, {
      authenticatedHost,
      expiresAt: Date.now() + (authenticatedHost ? HOST_AUTH_TTL_MS : HOST_AUTH_MISS_TTL_MS)
    })
    pruneHostAuthCache(Date.now())
    return authenticatedHost
  })()
  hostAuthInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (hostAuthInFlight.get(cacheKey) === probe) {
      hostAuthInFlight.delete(cacheKey)
    }
  }
}

/** Match untrusted hosts against local auth inventory without passing them to gh or exposing ambient tokens. */
export async function isGitHubHostAuthenticated(
  host: string,
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  return Boolean(
    await resolveAuthenticatedGitHubHost(host, repoPath, connectionId, localGitOptions)
  )
}

/** Safely validate a project-selected host without giving the untrusted host
 * to gh. Global project calls have no repository cwd, so they use native gh. */
export function isGitHubHostAuthenticatedForGlobalCli(host: string): Promise<boolean> {
  return isGitHubHostAuthenticated(host, '', 'project-host-validation')
}

/** Resolve authenticated custom GitHub hosts; github.com and unauthenticated other forges return null. */
export async function getEnterpriseGitHubRepoSlugForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  requireVerifiedSshProbe = false
): Promise<GitHubEnterpriseRepoSlug | null | undefined> {
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  if (requireVerifiedSshProbe) {
    requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  }
  let remoteUrl: string | null
  try {
    remoteUrl = await getRemoteUrlForRepo(context, remoteName)
  } catch (error) {
    if (requireVerifiedSshProbe && connectionId && !isStableMissingGitRemoteError(error)) {
      throw error
    }
    return null
  }
  if (requireVerifiedSshProbe && !remoteUrl) {
    requireReachableGitRoute(getConnectionExecutionHostId(connectionId))
  }
  const identity = remoteUrl ? parseGitHubRemoteIdentity(remoteUrl) : null
  if (!identity) {
    return null
  }
  let effectiveHost = identity.host
  const aliasHost = remoteUrl ? gitHubSshConfigHostAlias(remoteUrl) : null
  if (aliasHost) {
    const { hostname, resolved } = await resolveSshConfigHostname(aliasHost, context)
    if (!resolved || !hostname) {
      if (requireVerifiedSshProbe && connectionId) {
        throw new Error('Remote repository identity is unverifiable.')
      }
      const authenticatedLiteralHost = await resolveAuthenticatedGitHubHost(
        identity.host,
        repoPath,
        connectionId,
        localGitOptions
      )
      return authenticatedLiteralHost
        ? { owner: identity.owner, repo: identity.repo, host: authenticatedLiteralHost }
        : undefined
    }
    effectiveHost = effectiveGitHubRemoteHost(identity.host, hostname)
  }
  if (effectiveHost === 'github.com') {
    return null
  }
  const authenticatedHost = await resolveAuthenticatedGitHubHost(
    effectiveHost,
    repoPath,
    connectionId,
    localGitOptions
  )
  if (authenticatedHost === undefined) {
    return undefined
  }
  return authenticatedHost
    ? { owner: identity.owner, repo: identity.repo, host: authenticatedHost }
    : null
}

export async function getEnterpriseGitHubRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  requireVerifiedSshProbe = false
): Promise<GitHubEnterpriseRepoSlug | null | undefined> {
  return getEnterpriseGitHubRepoSlugForRemote(
    repoPath,
    'origin',
    connectionId,
    options,
    requireVerifiedSshProbe
  )
}
