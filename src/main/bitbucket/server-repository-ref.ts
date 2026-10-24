import { createRemoteRefProbeCache } from '../git/remote-ref-probe-cache'
import { getBitbucketServerBaseUrl } from './server-auth-config'

export type BitbucketServerRepoRef = {
  baseUrl: string
  projectKey: string
  repoSlug: string
}

type LocalGitExecOptions = {
  wslDistro?: string
}

const repoRefProbeCache = createRemoteRefProbeCache((remoteUrl) =>
  parseBitbucketServerRepoRef(remoteUrl, getBitbucketServerBaseUrl())
)

/** @internal - also called when the server credential changes, so detection follows it at once. */
export function _resetBitbucketServerRepoRefCache(): void {
  repoRefProbeCache.clear()
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function refFromSegments(
  baseUrl: string,
  segments: readonly string[]
): BitbucketServerRepoRef | null {
  if (segments.length !== 2) {
    return null
  }
  const [projectKey, repoSlug] = segments.map((segment) =>
    decodeSegment(segment.replace(/\.git$/i, ''))
  )
  return projectKey && repoSlug ? { baseUrl, projectKey, repoSlug } : null
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean)
}

export function parseBitbucketServerRepoRef(
  remoteUrl: string,
  baseUrl: string | null
): BitbucketServerRepoRef | null {
  if (!baseUrl) {
    return null
  }
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return null
  }
  const serverHost = base.hostname.toLowerCase()
  const trimmed = remoteUrl.trim()

  const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+)$/)
  if (scpLike && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return scpLike[1].toLowerCase() === serverHost
      ? refFromSegments(baseUrl, splitPath(scpLike[2]))
      : null
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.hostname.toLowerCase() !== serverHost) {
    return null
  }
  if (url.protocol === 'ssh:' || url.protocol === 'git+ssh:') {
    return refFromSegments(baseUrl, splitPath(url.pathname))
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  // Why: Server serves HTTP clones only under <context path>/scm/<project>/<repo>.
  const contextPath = base.pathname.replace(/\/+$/, '')
  if (contextPath && !url.pathname.toLowerCase().startsWith(`${contextPath.toLowerCase()}/`)) {
    return null
  }
  const segments = splitPath(url.pathname.slice(contextPath.length))
  return segments[0]?.toLowerCase() === 'scm' ? refFromSegments(baseUrl, segments.slice(1)) : null
}

export async function getBitbucketServerRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<BitbucketServerRepoRef | null> {
  // Why: skip the git remote read entirely for the common case of no registered server.
  if (!getBitbucketServerBaseUrl()) {
    return null
  }
  return repoRefProbeCache.get(repoPath, 'origin', connectionId, localGitOptions)
}
