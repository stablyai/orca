import { gitExecFileAsync } from '../git/runner'
import type { GitHubOwnerRepo, IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { readLocalGitConfigSignature } from './local-git-config-signature'
import {
  parseGitHubOwnerRepo,
  parseGitHubRemoteIdentity,
  type GitHubRemoteIdentity
} from './github-remote-identity-parsing'
import { isStableMissingGitRemoteError } from './stable-missing-git-remote-error'
import { githubRepoIdentityKey } from '../../shared/github-repository-identity-key'

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

const OWNER_REPO_POSITIVE_CACHE_TTL_MS = 30_000
const OWNER_REPO_NEGATIVE_CACHE_TTL_MS = 5 * 60_000
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
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const runtimeKey = context.connectionId ?? `local:${context.wslDistro ?? 'host'}`
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
    const result = remoteUrl ? parseGitHubOwnerRepo(remoteUrl) : null
    if (result) {
      ownerRepoCache.set(cacheKey, {
        value: result,
        expiresAt: now + getOwnerRepoCacheTtl(result, configSignature)
      })
      pruneOwnerRepoCache(now)
      return result
    }
  } catch (error) {
    // Why: only stable "no such remote" misses are safe to hold for minutes.
    // Transient git lock/IO failures must retry on the next lookup.
    if (!isStableMissingGitRemoteError(error)) {
      return null
    }
  }
  // Why: a missing/non-GitHub remote is stable until `.git/config` changes.
  // Holding that negative longer avoids Git process churn across PR polling.
  ownerRepoCache.set(cacheKey, {
    value: null,
    expiresAt: now + getOwnerRepoCacheTtl(null, configSignature),
    ...(configSignature ? { configSignature } : {})
  })
  pruneOwnerRepoCache(now)
  return null
}

export async function getOwnerRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  // Why: on a fork checkout PRs live on the upstream parent, not origin (#7331).
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions)
  if (upstream) {
    return upstream
  }
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

export async function getIssueOwnerRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions)
  if (upstream) {
    return upstream
  }
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

export type PRRepositoryCandidates = {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
}

function ownerRepoKey(ownerRepo: OwnerRepo): string {
  return githubRepoIdentityKey(ownerRepo)
}

export async function resolvePRRepositoryCandidates(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRRepositoryCandidates> {
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions)
  const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
  const seen = new Set<string>()
  const candidates: OwnerRepo[] = []

  for (const candidate of [upstream, origin]) {
    if (!candidate) {
      continue
    }
    const key = ownerRepoKey(candidate)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }

  return { candidates, headRepo: origin }
}

export type ResolvedIssueSource = {
  source: OwnerRepo | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getOwnerRepoForRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions),
      fellBack: false
    }
  }
  return {
    source: await getIssueOwnerRepo(repoPath, connectionId, localGitOptions),
    fellBack: false
  }
}
