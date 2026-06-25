import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

export type GiteaRepoRef = {
  host: string
  owner: string
  repo: string
  apiBaseUrl: string
  webBaseUrl: string
}

type LocalGitExecOptions = {
  wslDistro?: string
}

const KNOWN_NON_GITEA_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com'
])
const REPO_REF_CACHE_MAX_ENTRIES = 512
const repoRefCache = new Map<string, GiteaRepoRef | null>()

/** @internal - exposed for tests only */
export function _resetGiteaRepoRefCache(): void {
  repoRefCache.clear()
}

/** @internal - exposed for tests only */
export function _getGiteaRepoRefCacheSize(): number {
  return repoRefCache.size
}

function rememberRepoRefCacheEntry(cacheKey: string, value: GiteaRepoRef | null): void {
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

function parsePath(pathname: string): { owner: string; repo: string; basePath: string } | null {
  const withoutSuffix = pathname.replace(/\/+$/, '').replace(/\.git$/i, '')
  const parts = withoutSuffix
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    return null
  }

  const owner = decodeSegment(parts.at(-2) ?? '')
  const repo = decodeSegment(parts.at(-1) ?? '')
  if (!owner || !repo) {
    return null
  }

  return {
    owner,
    repo,
    basePath: parts.slice(0, -2).join('/')
  }
}

function apiBaseUrlFromWebBase(webBaseUrl: string): string {
  return `${webBaseUrl.replace(/\/+$/, '')}/api/v1`
}

function makeRepoRef(host: string, path: string, webOrigin: string): GiteaRepoRef | null {
  const normalizedHost = host.toLowerCase()
  if (
    !normalizedHost ||
    KNOWN_NON_GITEA_HOSTS.has(normalizedHost) ||
    normalizedHost.endsWith('.visualstudio.com')
  ) {
    return null
  }

  const parsed = parsePath(path)
  if (!parsed) {
    return null
  }

  // Why: Gitea/Forgejo can be hosted below a URL subpath. SSH-style remotes
  // carry that base path in the repo path, so derive the web/API base here.
  const webBaseUrl = parsed.basePath
    ? `${webOrigin.replace(/\/+$/, '')}/${parsed.basePath}`
    : webOrigin
  return {
    host: normalizedHost,
    owner: parsed.owner,
    repo: parsed.repo,
    apiBaseUrl: apiBaseUrlFromWebBase(webBaseUrl),
    webBaseUrl
  }
}

export function parseGiteaRepoRef(remoteUrl: string): GiteaRepoRef | null {
  const trimmed = remoteUrl.trim()
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      const host = scpLike[1]
      const path = scpLike[2]
      return makeRepoRef(host, path, `https://${host.toLowerCase()}`)
    }
  }

  try {
    const url = new URL(trimmed)
    const protocol = url.protocol.toLowerCase()
    if (!['http:', 'https:', 'ssh:', 'git+ssh:'].includes(protocol)) {
      return null
    }

    const parsed = parsePath(url.pathname)
    if (!parsed) {
      return null
    }

    const webOrigin =
      protocol === 'http:' || protocol === 'https:'
        ? `${protocol}//${url.host}`
        : `https://${url.hostname.toLowerCase()}`
    return makeRepoRef(url.hostname, url.pathname, webOrigin)
  } catch {
    return null
  }
}

export async function getGiteaRepoRefForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}`
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
          cwd: repoPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    const result = parseGiteaRepoRef(stdout)
    rememberRepoRefCacheEntry(cacheKey, result)
    return result
  } catch {
    if (connectionId) {
      // Why: SSH provider failures are often transient reconnect/tunnel states;
      // caching them as "not Gitea" would poison the repo for the session.
      return null
    }
    rememberRepoRefCacheEntry(cacheKey, null)
    return null
  }
}

export async function getGiteaRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  return getGiteaRepoRefForRemote(repoPath, 'origin', connectionId, localGitOptions)
}
