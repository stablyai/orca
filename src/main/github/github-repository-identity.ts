import { AsyncLocalStorage } from 'node:async_hooks'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { readRemoteUrl } from '../git/remote-url-probe'
import type { GhAccountBinding } from '../../shared/github/account-binding'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import { readLocalGitConfigSignature } from './local-git-config-signature'
import {
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity
} from './github-remote-identity-parsing'
import { classifyGitHubOwnerRepoFromRemoteUrl } from './github-ssh-host-alias-resolution'
import { isStableMissingGitRemoteError } from '../git/stable-missing-git-remote-error'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { requireReachableGitRoute } from '../providers/execution-host-provider-dispatch'
import { getConnectionExecutionHostId } from '../../shared/execution-host'
import { resolveGitHubProjectAccount } from './github-project-account'

export type OwnerRepo = GitHubOwnerRepo

export type { GitHubRemoteIdentity }
export { parseGitHubOwnerRepo, parseGitHubRemoteIdentity }

export type GitHubRepoContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  /** SSH keeps the binding even when cwd is omitted from gh options. */
  ghAccount?: GhAccountBinding
}

export type LocalGitExecOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  ghAccount?: GhAccountBinding
}

export type GitHubRemoteIdentityProbeOptions = {
  requireVerifiedSshProbe?: boolean
}

const operations = new AsyncLocalStorage<GitHubRepoContext>()

export async function withGitHubRepoExecution<T>(
  repoPath: string,
  connectionId: string | null | undefined,
  options: LocalGitExecOptions,
  operation: () => Promise<T>
): Promise<T> {
  // Async descendants keep the selection through settlement, including detached cache work.
  return operations.run(githubRepoContext(repoPath, connectionId, options), operation)
}

export function githubRepoContext(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): GitHubRepoContext {
  const context = {
    repoPath,
    connectionId: connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
    ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {}),
    ...(localGitOptions.ghAccount ? { ghAccount: localGitOptions.ghAccount } : {})
  }
  const scope = operations.getStore()
  const pinned =
    scope &&
    scope.repoPath === repoPath &&
    scope.connectionId === context.connectionId &&
    scope.wslDistro === context.wslDistro
      ? scope
      : null
  const account = pinned ?? resolveGitHubProjectAccount(context) ?? context
  const binding = account.ghAccount ? Object.freeze({ ...account.ghAccount }) : undefined
  return Object.freeze({ ...context, ghAccount: binding })
}

export function ghRepoExecOptions(context: GitHubRepoContext): {
  cwd?: string
  encoding?: BufferEncoding
  wslDistro?: string
  admissionTier?: GitAdmissionTier
  ghAccount?: GhAccountBinding
} {
  const account = context.ghAccount ? { ghAccount: context.ghAccount } : {}
  return context.connectionId
    ? { ...account }
    : {
        cwd: context.repoPath,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}),
        ...(context.admissionTier ? { admissionTier: context.admissionTier } : {}),
        ...account
      }
}

const OWNER_REPO_POSITIVE_CACHE_TTL_MS = 30_000
const OWNER_REPO_NEGATIVE_CACHE_TTL_MS = 5 * 60_000
// Signed entries revalidate against Git config before reuse.
const OWNER_REPO_SIGNED_CACHE_TTL_MS = 5 * 60_000
const OWNER_REPO_CACHE_MAX_ENTRIES = 512

type OwnerRepoCacheEntry = {
  value: OwnerRepo | null
  expiresAt: number
  configSignature?: string
}

const ownerRepoCache = new Map<string, OwnerRepoCacheEntry>()
const ownerRepoInFlight: CoalescedProbes<OwnerRepo | null> = new Map()

/** @internal - exposed for tests only */
export function _resetOwnerRepoCache(): void {
  ownerRepoCache.clear()
  ownerRepoInFlight.clear()
}

/** @internal - exposed for tests only */
export function _getOwnerRepoCacheSize(): number {
  return ownerRepoCache.size
}

function pruneOwnerRepoCache(now: number): void {
  for (const [key, entry] of ownerRepoCache) {
    if (entry.expiresAt <= now) {
      ownerRepoCache.delete(key)
    }
  }
  while (ownerRepoCache.size > OWNER_REPO_CACHE_MAX_ENTRIES) {
    const oldestKey = ownerRepoCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    ownerRepoCache.delete(oldestKey)
  }
}

export async function getRemoteUrlForRepo(
  context: GitHubRepoContext,
  remoteName: string
): Promise<string | null> {
  return readRemoteUrl(context, remoteName)
}

function getOwnerRepoCacheTtl(value: OwnerRepo | null, configSignature?: string): number {
  if (configSignature) {
    return value ? OWNER_REPO_SIGNED_CACHE_TTL_MS : OWNER_REPO_NEGATIVE_CACHE_TTL_MS
  }
  return OWNER_REPO_POSITIVE_CACHE_TTL_MS
}

export async function getOwnerRepoForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  probeOptions: GitHubRemoteIdentityProbeOptions = {}
): Promise<OwnerRepo | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  if (probeOptions.requireVerifiedSshProbe) {
    requireReachableGitRoute(getConnectionExecutionHostId(context.connectionId))
  }
  const runtimeKey = context.connectionId
    ? `ssh:${context.connectionId}`
    : `local:${context.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${context.repoPath}\0${remoteName}`
  const now = Date.now()
  pruneOwnerRepoCache(now)
  const cached = ownerRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    // Revalidate signed hits so remote changes are immediately visible.
    if (cached.configSignature !== undefined) {
      const currentSignature = await readLocalGitConfigSignature(context)
      if (currentSignature !== cached.configSignature) {
        ownerRepoCache.delete(cacheKey)
      } else {
        return cached.value
      }
    } else {
      return cached.value
    }
  }
  if (cached && cached.expiresAt <= now) {
    ownerRepoCache.delete(cacheKey)
  }

  const nextConfigSignature = await readLocalGitConfigSignature(context)
  const refreshedNow = Date.now()
  const refreshedCached = ownerRepoCache.get(cacheKey)
  if (refreshedCached && refreshedCached.expiresAt > refreshedNow) {
    return refreshedCached.value
  }

  // Coalesce concurrent identity probes, but retire wedged work so it cannot pin identity forever.
  const inFlightKey = `${cacheKey}\0${probeOptions.requireVerifiedSshProbe ? 'verified' : 'tolerant'}`
  return runCoalescedProbe(ownerRepoInFlight, inFlightKey, () =>
    resolveOwnerRepoForRemote(
      context,
      remoteName,
      cacheKey,
      nextConfigSignature,
      probeOptions.requireVerifiedSshProbe === true
    )
  )
}

async function resolveOwnerRepoForRemote(
  context: GitHubRepoContext,
  remoteName: string,
  cacheKey: string,
  configSignature: string | undefined,
  requireVerifiedSshProbe: boolean
): Promise<OwnerRepo | null> {
  const now = Date.now()
  try {
    const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
    if (!remoteUrl) {
      if (requireVerifiedSshProbe) {
        requireReachableGitRoute(getConnectionExecutionHostId(context.connectionId))
      }
      // Empty remote URL is stable until git config changes.
      ownerRepoCache.set(cacheKey, {
        value: null,
        expiresAt: now + getOwnerRepoCacheTtl(null, configSignature),
        ...(configSignature ? { configSignature } : {})
      })
      pruneOwnerRepoCache(now)
      return null
    }
    const classification = await classifyGitHubOwnerRepoFromRemoteUrl(remoteUrl, context)
    if (classification.kind === 'github') {
      // Signed entries still expire and revalidate Git config on reuse.
      ownerRepoCache.set(cacheKey, {
        value: classification.ownerRepo,
        expiresAt: now + getOwnerRepoCacheTtl(classification.ownerRepo, configSignature),
        ...(configSignature ? { configSignature } : {})
      })
      pruneOwnerRepoCache(now)
      return classification.ownerRepo
    }
    if (classification.kind === 'indeterminate') {
      // Why: a failed ssh -G probe is not a stable "not GitHub" result.
      if (requireVerifiedSshProbe && context.connectionId) {
        throw new Error('Remote repository identity is unverifiable.')
      }
      return null
    }
    const stableConfigSignature = classification.cacheWithGitConfigSignature
      ? configSignature
      : undefined
    ownerRepoCache.set(cacheKey, {
      value: null,
      expiresAt: now + getOwnerRepoCacheTtl(null, stableConfigSignature),
      ...(stableConfigSignature ? { configSignature: stableConfigSignature } : {})
    })
    pruneOwnerRepoCache(now)
    return null
  } catch (error) {
    // Cache stable missing remotes only; transient lock/I/O failures must retry.
    if (!isStableMissingGitRemoteError(error)) {
      if (requireVerifiedSshProbe && context.connectionId) {
        throw error
      }
      return null
    }
  }
  // Config changes invalidate stable negative remote results before their longer TTL.
  ownerRepoCache.set(cacheKey, {
    value: null,
    expiresAt: now + getOwnerRepoCacheTtl(null, configSignature),
    ...(configSignature ? { configSignature } : {})
  })
  pruneOwnerRepoCache(now)
  return null
}
