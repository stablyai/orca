import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

export type BitbucketRepoRef = {
  workspace: string
  repoSlug: string
}

const repoRefCache = new Map<string, BitbucketRepoRef | null>()

/** @internal - exposed for tests only */
export function _resetBitbucketRepoRefCache(): void {
  repoRefCache.clear()
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function parseBitbucketPath(pathname: string): BitbucketRepoRef | null {
  const withoutSuffix = pathname.replace(/\.git$/i, '')
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
    repoRefCache.set(cacheKey, result)
    return result
  } catch {
    if (connectionId) {
      // Why: SSH provider failures are often transient reconnect/tunnel states;
      // caching them as "not Bitbucket" would poison the repo for the session.
      return null
    }
    repoRefCache.set(cacheKey, null)
    return null
  }
}

export async function getBitbucketRepoRef(
  repoPath: string,
  connectionId?: string | null
): Promise<BitbucketRepoRef | null> {
  return getBitbucketRepoRefForRemote(repoPath, 'origin', connectionId)
}
