import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { getCustomGitServerForHost, listCustomGitServers } from './server-config-store'
import type { CustomGitServerRepoRef } from './api-flavor-client'

type LocalGitExecOptions = {
  wslDistro?: string
}

type ParsedRemote = { host: string; owner: string; repo: string }

const REPO_REF_CACHE_MAX_ENTRIES = 512
// Why: bound staleness so an external `git remote set-url` is re-read soon, not held until eviction.
const REPO_REF_CACHE_TTL_MS = 30_000
// Why: cache the (stable) parsed remote, NOT the server match — the configured
// server list changes at runtime (user adds a server), so the host→server match
// must be re-evaluated every call against the live config.
const remoteCache = new Map<string, { at: number; value: ParsedRemote | null }>()

/** @internal - exposed for tests only */
export function _resetCustomGitServerRepoRefCache(): void {
  remoteCache.clear()
}

function rememberCacheEntry(cacheKey: string, value: ParsedRemote | null): void {
  remoteCache.set(cacheKey, { at: Date.now(), value })
  while (remoteCache.size > REPO_REF_CACHE_MAX_ENTRIES) {
    const oldestKey = remoteCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    remoteCache.delete(oldestKey)
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Parse owner/repo from a remote path. owner may span nested groups. */
function parseOwnerRepo(pathname: string): { owner: string; repo: string } | null {
  const parts = pathname
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    return null
  }
  const owner = decodeSegment(parts.slice(0, -1).join('/'))
  const repo = decodeSegment(parts.at(-1) ?? '')
  return owner && repo ? { owner, repo } : null
}

/** Parse a remote URL into `{ host, owner, repo }`. */
export function parseCustomGitServerRemote(remoteUrl: string): ParsedRemote | null {
  const trimmed = remoteUrl.trim()
  // scp-like: [user@]host:owner/repo(.git)
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scpLike = trimmed.match(/^(?:[^@/:]+@)?([^:\s/]+):([^\s]+?)(?:\.git)?$/)
    if (scpLike) {
      const owner = parseOwnerRepo(scpLike[2])
      return owner ? { host: scpLike[1].toLowerCase(), ...owner } : null
    }
    return null
  }
  try {
    const url = new URL(trimmed)
    const protocol = url.protocol.toLowerCase()
    if (!['http:', 'https:', 'ssh:', 'git+ssh:', 'git:'].includes(protocol)) {
      return null
    }
    const parsed = parseOwnerRepo(url.pathname)
    if (!parsed) {
      return null
    }
    // http(s) endpoint identity includes the port; ssh port is transport-only.
    const host = protocol === 'http:' || protocol === 'https:' ? url.host : url.hostname
    return { host: host.toLowerCase(), ...parsed }
  } catch {
    return null
  }
}

async function getOriginUrl(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  const sshGitProvider = connectionId ? getSshGitProvider(connectionId) : null
  if (connectionId && !sshGitProvider) {
    return null
  }
  const { stdout } = sshGitProvider
    ? await sshGitProvider.exec(['remote', 'get-url', 'origin'], repoPath)
    : await gitExecFileAsync(['remote', 'get-url', 'origin'], {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      })
  return stdout
}

/**
 * Resolve the repository against configured custom servers. Reads the origin
 * remote (via the repo's own git/ssh runtime) and returns a ref only when the
 * remote host matches a saved server. API calls themselves originate in main.
 */
export async function getCustomGitServerRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<CustomGitServerRepoRef | null> {
  const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}`
  // Why: when no custom servers are configured, skip the remote probe entirely —
  // the feature is off, so there's no point spawning `git remote get-url` (and it
  // keeps unrelated forge-provider detection tests from touching git).
  if (listCustomGitServers().length === 0) {
    return null
  }
  let parsed: ParsedRemote | null
  const cached = remoteCache.get(cacheKey)
  // Treat a stale entry (past its TTL) as a miss so an external origin change is re-read.
  if (cached && Date.now() - cached.at <= REPO_REF_CACHE_TTL_MS) {
    parsed = cached.value
  } else {
    try {
      const stdout = await getOriginUrl(repoPath, connectionId, localGitOptions)
      parsed = stdout ? parseCustomGitServerRemote(stdout) : null
      // Don't cache under a connection — its tunnel/get-url can be transiently flaky.
      if (!connectionId) {
        rememberCacheEntry(cacheKey, parsed)
      }
    } catch {
      return null
    }
  }
  if (!parsed) {
    return null
  }
  // Re-match against the live server list every call so a newly added server is
  // picked up without a cache invalidation.
  const server = getCustomGitServerForHost(parsed.host)
  return server ? { server, owner: parsed.owner, repo: parsed.repo } : null
}

/** Whether the repo's matched custom server has a usable saved token. */
export async function isCustomGitServerAuthenticatedForRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  const ref = await getCustomGitServerRepoRef(repoPath, connectionId, localGitOptions)
  if (!ref) {
    return false
  }
  try {
    // Lazy so the electron-backed token store stays out of this module's static
    // graph (which forge-provider detection depends on).
    const { getCustomGitServerToken } = await import('./token-store')
    return getCustomGitServerToken(ref.server.id) !== null
  } catch {
    return false
  }
}
