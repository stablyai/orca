import { gitExecFileAsync } from '../git/runner'
import type { GitHubOwnerRepo } from '../../shared/types'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { readLocalGitConfigSignature } from './local-git-config-signature'
import {
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity
} from './github-remote-identity-parsing'
import { classifyGitHubOwnerRepoFromRemoteUrl } from './github-ssh-host-alias-resolution'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'

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

// Why: without a `.git/config` signature to revalidate against we can only
// time-bound staleness, so hold briefly; with a signature we hold far longer and
// let the signature drive invalidation.
const OWNER_REPO_UNSIGNED_CACHE_TTL_MS = 30_000
const OWNER_REPO_SIGNATURE_CACHE_TTL_MS = 5 * 60_000
const OWNER_REPO_CACHE_MAX_ENTRIES = 512

type OwnerRepoCacheEntry = {
  value: OwnerRepo | null
  expiresAt: number
  configSignature?: string
}

const ownerRepoCache = new Map<string, OwnerRepoCacheEntry>()
const ownerRepoInFlight = new Map<string, Promise<OwnerRepo | null>>()

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
  if (context.connectionId) {
    const provider = getSshGitProvider(context.connectionId)
    if (!provider) {
      return null
    }
    const { stdout } = await provider.exec(['remote', 'get-url', remoteName], context.repoPath)
    return stdout
  }
  const { stdout } = await gitExecFileAsync(['remote', 'get-url', remoteName], {
    cwd: context.repoPath,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
  })
  return stdout
}

function getOwnerRepoCacheTtl(configSignature?: string): number {
  // Why: a resolved owner/repo and a missing remote are both stable until
  // `.git/config` changes, so when we have a signature to revalidate against,
  // hold either far longer than the 30s fallback — this stops per-worktree PR
  // polling from re-spawning `git remote get-url` every tick (#7576).
  return configSignature ? OWNER_REPO_SIGNATURE_CACHE_TTL_MS : OWNER_REPO_UNSIGNED_CACHE_TTL_MS
}

export async function getOwnerRepoForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const runtimeKey = context.connectionId
    ? `ssh:${context.connectionId}:${getSshGitProviderGeneration(context.connectionId)}`
    : `local:${context.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${context.repoPath}\0${remoteName}`
  const now = Date.now()
  pruneOwnerRepoCache(now)
  const cached = ownerRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    if (cached.configSignature !== undefined) {
      // Why: revalidating against the config signature (a cheap re-stat) lets us
      // hold resolved AND missing remotes until `.git/config` actually moves,
      // instead of re-spawning `git remote get-url` on the next poll.
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

  const inFlight = ownerRepoInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  // Why: startup can resolve issue sources, PR candidates, and repo metadata
  // for the same repo concurrently. Coalesce missing-remote probes.
  const probe = resolveOwnerRepoForRemote(context, remoteName, cacheKey, nextConfigSignature)
  ownerRepoInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (ownerRepoInFlight.get(cacheKey) === probe) {
      ownerRepoInFlight.delete(cacheKey)
    }
  }
}

async function resolveOwnerRepoForRemote(
  context: GitHubRepoContext,
  remoteName: string,
  cacheKey: string,
  configSignature?: string
): Promise<OwnerRepo | null> {
  const now = Date.now()
  try {
    const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
    if (!remoteUrl) {
      // Empty remote URL is stable until git config changes.
      ownerRepoCache.set(cacheKey, {
        value: null,
        expiresAt: now + getOwnerRepoCacheTtl(configSignature),
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
        expiresAt: now + getOwnerRepoCacheTtl(configSignature),
        ...(configSignature ? { configSignature } : {})
      })
      pruneOwnerRepoCache(now)
      return classification.ownerRepo
    }
    if (classification.kind === 'indeterminate') {
      // Why: a failed ssh -G probe is not a stable "not GitHub" result.
      return null
    }
    const stableConfigSignature = classification.cacheWithGitConfigSignature
      ? configSignature
      : undefined
    ownerRepoCache.set(cacheKey, {
      value: null,
      expiresAt: now + getOwnerRepoCacheTtl(stableConfigSignature),
      ...(stableConfigSignature ? { configSignature: stableConfigSignature } : {})
    })
    pruneOwnerRepoCache(now)
    return null
  } catch (error) {
    // Why: only stable "no such remote" misses are safe to hold for minutes.
    // Transient git lock/IO failures must retry on the next lookup.
    if (!isStableMissingGitRemoteError(error)) {
      return null
    }
  }
  // Why: a missing remote is stable until `.git/config` changes.
  // Holding that negative longer avoids Git process churn across PR polling.
  ownerRepoCache.set(cacheKey, {
    value: null,
    expiresAt: now + getOwnerRepoCacheTtl(configSignature),
    ...(configSignature ? { configSignature } : {})
  })
  pruneOwnerRepoCache(now)
  return null
}
