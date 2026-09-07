import { createRemoteRefProbeCache } from '../git/remote-ref-probe-cache'

export type BitbucketRepoRef = {
  workspace: string
  repoSlug: string
}

type LocalGitExecOptions = {
  wslDistro?: string
}

const repoRefProbeCache = createRemoteRefProbeCache(parseBitbucketRepoRef)

/** @internal - exposed for tests only */
export function _resetBitbucketRepoRefCache(): void {
  repoRefProbeCache.clear()
}

/** @internal - exposed for tests only */
export function _getBitbucketRepoRefCacheSize(): number {
  return repoRefProbeCache.size()
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
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<BitbucketRepoRef | null> {
  return repoRefProbeCache.get(repoPath, remoteName, connectionId, localGitOptions)
}

export async function getBitbucketRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<BitbucketRepoRef | null> {
  return getBitbucketRepoRefForRemote(repoPath, 'origin', connectionId, localGitOptions)
}
