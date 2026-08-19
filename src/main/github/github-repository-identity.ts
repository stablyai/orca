import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { readRemoteUrl } from '../git/remote-url-probe'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import {
  getSshGitProvider,
  getSshGitProviderGeneration,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import { readLocalGitConfigSignature } from './local-git-config-signature'
import {
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity
} from './github-remote-identity-parsing'
import { classifyGitHubOwnerRepoFromRemoteUrl } from './github-ssh-host-alias-resolution'
import { isStableMissingGitRemoteError } from '../git/stable-missing-git-remote-error'

export type OwnerRepo = GitHubOwnerRepo

export type { GitHubRemoteIdentity }
export { parseGitHubOwnerRepo, parseGitHubRemoteIdentity }

export type GitHubRepoContext = {
  repoPath: string
  connectionId?: string | null
  wslDistro?: string
}

export type LocalGitExecOptions = {
  wslDistro?: string
}

export type GitHubRemoteIdentityProbeOptions = {
  requireVerifiedSshProbe?: boolean
}

export function githubRepoContext(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): GitHubRepoContext {
  return {
    repoPath,
    connectionId: connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
}

export function ghRepoExecOptions(context: GitHubRepoContext): {
  cwd?: string
  encoding?: BufferEncoding
  wslDistro?: string
} {
  return context.connectionId
    ? {}
    : {
        cwd: context.repoPath,
        ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
      }
}

const OWNER_REPO_POSITIVE_CACHE_TTL_MS = 30_000
const OWNER_REPO_NEGATIVE_CACHE_TTL_MS = 5 * 60_000
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
  if (value) {
    return OWNER_REPO_POSITIVE_CACHE_TTL_MS
  }
  return configSignature ? OWNER_REPO_NEGATIVE_CACHE_TTL_MS : OWNER_REPO_POSITIVE_CACHE_TTL_MS
}

export async function getOwnerRepoForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  probeOptions: GitHubRemoteIdentityProbeOptions = {}
): Promise<OwnerRepo | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  if (
    probeOptions.requireVerifiedSshProbe &&
    context.connectionId &&
    !getSshGitProvider(context.connectionId)
  ) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  const runtimeKey = context.connectionId
    ? `ssh:${context.connectionId}:${getSshGitProviderGeneration(context.connectionId)}`
    : `local:${context.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${context.repoPath}\0${remoteName}`
  const now = Date.now()
  pruneOwnerRepoCache(now)
  const cached = ownerRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    if (cached.value === null && cached.configSignature !== undefined) {
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

  // Why: startup can resolve issue sources, PR candidates, and repo metadata
  // for the same repo concurrently. Coalesce missing-remote probes — but only
  // onto one young enough to still answer, so a wedged probe cannot pin the
  // repo's identity for the life of the process (P1-D).
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
      if (
        requireVerifiedSshProbe &&
        context.connectionId &&
        !getSshGitProvider(context.connectionId)
      ) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
    // Why: PR mutations need the effective host behind an SSH alias.
    const classification = await classifyGitHubOwnerRepoFromRemoteUrl(remoteUrl, context)
    if (classification.kind === 'github') {
      ownerRepoCache.set(cacheKey, {
        value: classification.ownerRepo,
        expiresAt: now + getOwnerRepoCacheTtl(classification.ownerRepo, configSignature)
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
    // Why: only stable "no such remote" misses are safe to hold for minutes.
    // Transient git lock/IO failures must retry on the next lookup.
    if (!isStableMissingGitRemoteError(error)) {
      if (requireVerifiedSshProbe && context.connectionId) {
        throw error
      }
      return null
    }
  }
  // Why: a missing remote is stable until `.git/config` changes.
  // Holding that negative longer avoids Git process churn across PR polling.
  ownerRepoCache.set(cacheKey, {
    value: null,
    expiresAt: now + getOwnerRepoCacheTtl(null, configSignature),
    ...(configSignature ? { configSignature } : {})
  })
  pruneOwnerRepoCache(now)
  return null
}
