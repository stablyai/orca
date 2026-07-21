import { ghExecFileAsync } from '../git/runner'
import type { GitHubOwnerRepo } from '../../shared/types'
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
import { parseWslPath } from '../wsl'

export type GitHubEnterpriseRepoSlug = GitHubOwnerRepo & { host: string }

// Why: `gh` only ever manages github.com / GitHub Enterprise credentials, so a
// host `gh auth status` reports as logged-in is definitively a GitHub host. This
// mirrors the `glab auth status` signal GitLab self-hosted detection uses, so a
// GHES remote is not left to fall through to Gitea (#8312).
const HOST_AUTH_TTL_MS = 60_000
const HOST_AUTH_CACHE_MAX_ENTRIES = 512

type HostAuthCacheEntry = {
  authenticatedHost: string | null
  expiresAt: number
}

const hostAuthCache = new Map<string, HostAuthCacheEntry>()
const hostAuthInFlight = new Map<string, Promise<string | null | undefined>>()

// Why: connection-backed Git operations execute remotely, but gh intentionally
// executes on the native host. Only WSL selects a distinct gh config/runtime.
function runtimeCacheKey(repoPath: string, wslDistro?: string): string {
  const resolvedDistro = wslDistro ?? parseWslPath(repoPath)?.distro
  return `local:${resolvedDistro?.toLowerCase() ?? 'host'}`
}

/** @internal - exposed for tests only */
export function _resetGitHubHostAuthCache(): void {
  hostAuthCache.clear()
  hostAuthInFlight.clear()
}

/** @internal - exposed for cache-bound tests only */
export function _getGitHubHostAuthCacheSize(): number {
  return hostAuthCache.size
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

// Only gh's own stdout/stderr — not the Error.message — counts as an
// authoritative answer. A spawn failure (gh missing, ENOENT) carries just a
// message and no command output, and must stay indeterminate rather than be
// read as "host not authenticated".
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
  const rawPort = match[2] ?? null
  // Why: default web ports do not distinguish a gh auth host from the same
  // hostname without an explicit port.
  const port = rawPort === '80' || rawPort === '443' ? null : rawPort
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
  const compatible = inventory.filter(
    (candidate) =>
      candidate.hostname === requested.hostname && (!requested.port || candidate.port === null)
  )
  // Why: an SSH remote has no API port. Only a unique auth-inventory host can
  // safely supply it; multiple ported endpoints on one hostname are ambiguous.
  return compatible.length === 1 ? compatible[0].authority : null
}

async function resolveAuthenticatedGitHubHost(
  host: string,
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null | undefined> {
  const normalizedHost = normalizeGitHubHost(host)?.authority ?? host.trim().toLowerCase()
  const cacheKey = `${runtimeCacheKey(repoPath, localGitOptions.wslDistro)}\0${normalizedHost}`
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
  // Why: provider detection and review loading can probe the same runtime at
  // once; coalesce them so one host never spawns duplicate auth subprocesses.
  const probe = (async () => {
    const execOptions = {
      ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions))
    }
    let authenticatedHost: string | null
    try {
      const { stdout, stderr } = await ghExecFileAsync(['auth', 'status'], execOptions)
      authenticatedHost = authenticatedHostFromInventory(host, `${stdout}\n${stderr}`)
    } catch (error) {
      const output = ghCommandOutput(error)
      if (!output) {
        // Indeterminate (gh missing / spawn failure) — do not cache so a later
        // probe (gh installed, tunnel ready, token added) can recover.
        return undefined
      }
      // gh exits non-zero when a host has a token problem but still prints the
      // per-host status; trust only hosts that are actually listed.
      authenticatedHost = authenticatedHostFromInventory(host, output)
    }
    hostAuthCache.set(cacheKey, {
      authenticatedHost,
      expiresAt: Date.now() + HOST_AUTH_TTL_MS
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

/**
 * Whether `gh` is authenticated to `host` from the repository's own runtime.
 *
 * The probe inventories gh's configured hosts and matches `host` locally. It
 * deliberately does not pass an untrusted remote host to gh because ambient
 * enterprise tokens could otherwise be sent to that host during validation.
 * Cached briefly per runtime+host so provider-detection polling stays cheap.
 */
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

/**
 * Resolve owner/repo for a GitHub Enterprise Server remote — a custom host the
 * user is gh-authenticated to. Returns null for github.com (already handled by
 * {@link getOwnerRepo}) and for hosts gh is not logged in to
 * (Gitea/Forgejo/self-hosted GitLab/etc.), so GHES routes to the GitHub provider
 * without a GitHub provider stealing another forge's remote.
 */
export async function getEnterpriseGitHubRepoSlugForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GitHubEnterpriseRepoSlug | null | undefined> {
  const localGitOptions = getHostedReviewLocalGitOptions(options)
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  let remoteUrl: string | null
  try {
    remoteUrl = await getRemoteUrlForRepo(context, remoteName)
  } catch {
    return null
  }
  const identity = remoteUrl ? parseGitHubRemoteIdentity(remoteUrl) : null
  if (!identity || identity.host === 'github.com') {
    return null
  }
  const authenticatedHost = await resolveAuthenticatedGitHubHost(
    identity.host,
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
  options: HostedReviewExecutionOptions = {}
): Promise<GitHubEnterpriseRepoSlug | null | undefined> {
  return getEnterpriseGitHubRepoSlugForRemote(repoPath, 'origin', connectionId, options)
}
