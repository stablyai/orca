import { gitExecFileAsync } from '../git/runner'
import type { GitHubOwnerRepo, IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

export type OwnerRepo = GitHubOwnerRepo

export type GitHubRemoteIdentity = GitHubOwnerRepo & { host: string }

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

const OWNER_REPO_CACHE_TTL_MS = 30_000
const OWNER_REPO_CACHE_MAX_ENTRIES = 512

type OwnerRepoCacheEntry = {
  value: OwnerRepo | null
  expiresAt: number
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
    return cached.value
  }

  const inFlight = ownerRepoInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  // Why: startup can resolve issue sources, PR candidates, and repo metadata
  // for the same repo concurrently. Coalesce missing-remote probes.
  const probe = resolveOwnerRepoForRemote(context, remoteName, cacheKey)
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
  cacheKey: string
): Promise<OwnerRepo | null> {
  const now = Date.now()
  try {
    const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
    const result = remoteUrl ? parseGitHubOwnerRepo(remoteUrl) : null
    if (result) {
      ownerRepoCache.set(cacheKey, {
        value: result,
        expiresAt: now + OWNER_REPO_CACHE_TTL_MS
      })
      pruneOwnerRepoCache(now)
      return result
    }
  } catch {
    // ignore - non-GitHub remote or no remote
  }
  ownerRepoCache.set(cacheKey, { value: null, expiresAt: now + OWNER_REPO_CACHE_TTL_MS })
  pruneOwnerRepoCache(now)
  return null
}

export async function getOwnerRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

/** Normalized git origin identity (`host/owner/repo`, lowercased) for ANY git
 *  provider. Lets two checkouts of the same remote on different hosts group into
 *  one project even without a GitHub provider identity. `parseGitHubRemoteIdentity`
 *  is generic (host/owner/repo for any URL); only its GitHub-specific callers
 *  filter to github.com. Returns null when there's no parseable origin remote. */
export async function getOriginRemoteKey(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  try {
    const context = githubRepoContext(repoPath, connectionId, localGitOptions)
    const remoteUrl = await getRemoteUrlForRepo(context, 'origin')
    if (!remoteUrl) {
      return null
    }
    const identity = parseGitHubRemoteIdentity(remoteUrl)
    if (!identity) {
      return null
    }
    return `${identity.host}/${identity.owner}/${identity.repo}`.toLowerCase()
  } catch {
    return null
  }
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
  return `${ownerRepo.owner.toLowerCase()}/${ownerRepo.repo.toLowerCase()}`
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
