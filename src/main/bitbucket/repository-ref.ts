import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

export type BitbucketRepoRef = {
  workspace: string
  repoSlug: string
}

const REPO_REF_CACHE_MAX_ENTRIES = 512
const repoRefCache = new Map<string, BitbucketRepoRef | null>()

/** @internal - exposed for tests only */
export function _resetBitbucketRepoRefCache(): void {
  repoRefCache.clear()
}

/** @internal - exposed for tests only */
export function _getBitbucketRepoRefCacheSize(): number {
  return repoRefCache.size
}

function rememberRepoRefCacheEntry(cacheKey: string, value: BitbucketRepoRef | null): void {
  repoRefCache.set(cacheKey, value)
  while (repoRefCache.size > REPO_REF_CACHE_MAX_ENTRIES) {
    const oldestKey = repoRefCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    repoRefCache.delete(oldestKey)
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseBitbucketPath(pathname: string): BitbucketRepoRef | null {
  const withoutSuffix = pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = withoutSuffix
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    return null
  }
  const workspace = parts.at(-2)
  const repoSlug = parts.at(-1)
  if (!workspace || !repoSlug) {
    return null
  }
  return {
    workspace: decodeSegment(workspace),
    repoSlug: decodeSegment(repoSlug)
  }
}

export function parseBitbucketRepoRef(remoteUrl: string): BitbucketRepoRef | null {
  const trimmed = remoteUrl.trim()
  const scpLike = trimmed.match(/^(?:[^@]+@)?bitbucket\.org:([^\s]+?)(?:\.git)?$/i)
  if (scpLike) {
    return parseBitbucketPath(scpLike[1])
  }

  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() !== 'bitbucket.org') {
      return null
    }
    return parseBitbucketPath(url.pathname)
  } catch {
    return null
  }
}

export async function getBitbucketRepoRefForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null
): Promise<BitbucketRepoRef | null> {
  const cacheKey = `${connectionId ?? 'local'}\0${repoPath}\0${remoteName}`
  if (repoRefCache.has(cacheKey)) {
    return repoRefCache.get(cacheKey)!
  }
  try {
    const sshGitProvider = connectionId ? getSshGitProvider(connectionId) : null
    if (connectionId && !sshGitProvider) {
      return null
    }
    const { stdout } = sshGitProvider
      ? await sshGitProvider.exec(['remote', 'get-url', remoteName], repoPath)
      : await gitExecFileAsync(['remote', 'get-url', remoteName], {
          cwd: repoPath
        })
    const result = parseBitbucketRepoRef(stdout)
    rememberRepoRefCacheEntry(cacheKey, result)
    return result
  } catch {
    if (connectionId) {
      // Why: SSH provider failures are often transient reconnect/tunnel states;
      // caching them as "not Bitbucket" would poison the repo for the session.
      return null
    }
    rememberRepoRefCacheEntry(cacheKey, null)
    return null
  }
}

export async function getBitbucketRepoRef(
  repoPath: string,
  connectionId?: string | null
): Promise<BitbucketRepoRef | null> {
  return getBitbucketRepoRefForRemote(repoPath, 'origin', connectionId)
}
