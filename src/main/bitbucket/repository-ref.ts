import { createRemoteRefProbeCache } from '../git/remote-ref-probe-cache'
import { getBitbucketServerConfig } from './server-config'

export type BitbucketCloudRepoRef = {
  kind: 'cloud'
  workspace: string
  repoSlug: string
}

export type BitbucketServerRepoRef = {
  kind: 'server'
  /** Site base URL including any context path, without a trailing slash. */
  baseUrl: string
  /** Data Center project key; `~user` for personal repositories. */
  projectKey: string
  repoSlug: string
}

export type BitbucketRepoRef = BitbucketCloudRepoRef | BitbucketServerRepoRef

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

function pathSegments(pathname: string): string[] {
  return pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(decodeSegment)
}

type RemoteLocation = { host: string; origin: string; pathname: string }

function parseRemoteLocation(remoteUrl: string): RemoteLocation | null {
  const scpLike = remoteUrl.match(/^(?:[^@\s/]+@)?([^@\s/:]+):(?!\/)(.+)$/)
  if (scpLike) {
    const host = scpLike[1].toLowerCase()
    return { host, origin: `https://${host}`, pathname: `/${scpLike[2]}` }
  }
  try {
    const url = new URL(remoteUrl)
    const host = url.hostname.toLowerCase()
    // Why: Bitbucket web/REST URLs are https regardless of clone scheme, and
    // URL.origin is the literal string "null" for non-special schemes. An
    // ssh:// remote's port is the SSH port (7999 by default), which must not
    // survive into the REST base URL — but a real http(s) port must.
    const origin =
      url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : `https://${url.hostname}`
    return { host, origin, pathname: url.pathname }
  } catch {
    return null
  }
}

function parseBitbucketCloudRepoRef(location: RemoteLocation): BitbucketCloudRepoRef | null {
  if (location.host !== 'bitbucket.org') {
    return null
  }
  const parts = pathSegments(location.pathname)
  const workspace = parts.at(-2)
  const repoSlug = parts.at(-1)
  if (!workspace || !repoSlug) {
    return null
  }
  return { kind: 'cloud', workspace, repoSlug }
}

/**
 * Data Center is claimed on two positive signals only — the configured site
 * host, or the `/scm/` clone path that Atlassian fixes for every HTTPS remote.
 * A looser rule would make Bitbucket a second catch-all and steal the remotes
 * Gitea claims (it resolves after Bitbucket in FORGE_PROVIDERS).
 */
function parseBitbucketServerRepoRef(location: RemoteLocation): BitbucketServerRepoRef | null {
  const config = getBitbucketServerConfig()
  const matchesConfiguredHost = config.host !== null && config.host === location.host
  const parts = pathSegments(location.pathname)
  const scmIndex = parts.indexOf('scm')

  if (scmIndex !== -1 && parts.length >= scmIndex + 3) {
    const contextPath = parts.slice(0, scmIndex).join('/')
    return {
      kind: 'server',
      baseUrl:
        matchesConfiguredHost && config.baseUrl
          ? config.baseUrl
          : contextPath
            ? `${location.origin}/${contextPath}`
            : location.origin,
      projectKey: parts[scmIndex + 1],
      repoSlug: parts[scmIndex + 2]
    }
  }

  // SSH remotes carry neither `/scm` nor the context path, so they are only
  // resolvable against a configured site.
  if (!matchesConfiguredHost || !config.baseUrl || parts.length < 2) {
    return null
  }
  return {
    kind: 'server',
    baseUrl: config.baseUrl,
    projectKey: parts.at(-2)!,
    repoSlug: parts.at(-1)!
  }
}

export function parseBitbucketRepoRef(remoteUrl: string): BitbucketRepoRef | null {
  const location = parseRemoteLocation(remoteUrl.trim())
  if (!location) {
    return null
  }
  return parseBitbucketCloudRepoRef(location) ?? parseBitbucketServerRepoRef(location)
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
