import {
  createRemoteRefProbeCache,
  NEGATIVE_ENTRY_TTL_MS,
  type RemoteRefLocalGitOptions
} from '../git/remote-ref-probe-cache'
import { isTransientGitProbeError, readRemoteUrl } from '../git/remote-url-probe'
import { getTeaKnownLogins } from './gitea-known-host-probe'
import {
  configuredInstanceUrl,
  matchRemoteToGiteaLogin,
  remoteMatchesInstanceUrl
} from './gitea-login-remote-match'

export type GiteaRepoRef = {
  host: string
  owner: string
  repo: string
  apiBaseUrl: string
  webBaseUrl: string
  loginName?: string | null
}

export type LocalGitExecOptions = RemoteRefLocalGitOptions

const LOGIN_AWARE_CACHE_MAX_ENTRIES = 512

const KNOWN_NON_GITEA_HOSTS = new Set([
  'github.com',
  'gitlab.com',
  'bitbucket.org',
  'ssh.bitbucket.org',
  'dev.azure.com',
  'ssh.dev.azure.com'
])
const repoRefProbeCache = createRemoteRefProbeCache(parseGiteaRepoRef)
const loginAwareRepoRefCache = new Map<string, { value: GiteaRepoRef | null; expiresAt: number }>()

/** @internal - exposed for tests only */
export function _resetGiteaRepoRefCache(): void {
  repoRefProbeCache.clear()
  loginAwareRepoRefCache.clear()
}

/** @internal - exposed for tests only */
export function _getGiteaRepoRefCacheSize(): number {
  return repoRefProbeCache.size()
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

  // Self-hosted Gitea/Forgejo SSH paths can include the web/API base subpath.
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

function rememberLoginAwareRef(cacheKey: string, value: GiteaRepoRef | null): void {
  loginAwareRepoRefCache.set(cacheKey, {
    value,
    expiresAt: value === null ? Date.now() + NEGATIVE_ENTRY_TTL_MS : Number.POSITIVE_INFINITY
  })
  while (loginAwareRepoRefCache.size > LOGIN_AWARE_CACHE_MAX_ENTRIES) {
    const oldest = loginAwareRepoRefCache.keys().next().value
    if (oldest === undefined) {
      return
    }
    loginAwareRepoRefCache.delete(oldest)
  }
}

export function teaRepoArgs(repoRef: GiteaRepoRef): string[] {
  const args = ['--repo', `${repoRef.owner}/${repoRef.repo}`]
  if (repoRef.loginName) {
    args.push('--login', repoRef.loginName)
  }
  return args
}

export async function getGiteaRepoRefForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const logins = await getTeaKnownLogins(connectionId, localGitOptions)
  const envUrl = configuredInstanceUrl()
  if (logins.length === 0 && !envUrl) {
    return repoRefProbeCache.get(repoPath, remoteName, connectionId, localGitOptions)
  }

  const fingerprint = `${envUrl ?? ''}\0${logins
    .map((login) => `${login.name}\0${login.url}\0${login.sshHost}`)
    .join('\n')}`
  const runtimeKey = connectionId || `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}\0${fingerprint}`
  const cached = loginAwareRepoRefCache.get(cacheKey)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value
    }
    loginAwareRepoRefCache.delete(cacheKey)
  }

  try {
    const stdout = await readRemoteUrl(
      {
        repoPath,
        connectionId,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
      },
      remoteName
    )
    if (stdout === null) {
      return null
    }
    for (const login of logins) {
      const matched = matchRemoteToGiteaLogin(stdout, login)
      if (matched) {
        rememberLoginAwareRef(cacheKey, matched)
        return matched
      }
    }
    if (envUrl && remoteMatchesInstanceUrl(stdout, envUrl)) {
      const parsed = parseGiteaRepoRef(stdout)
      rememberLoginAwareRef(cacheKey, parsed)
      return parsed
    }
    // Logins and instance URLs are an allowlist, so other forges are not claimed as Gitea.
    rememberLoginAwareRef(cacheKey, null)
    return null
  } catch (error) {
    if (isTransientGitProbeError(error)) {
      return null
    }
    rememberLoginAwareRef(cacheKey, null)
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
