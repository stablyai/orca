import type {
  GetGitLabRateLimitResult,
  GitLabAuthDiagnostic,
  GitLabRateLimitSnapshot,
  GitLabViewer
} from '../../shared/gitlab-types'
import {
  acquire,
  glabApiWithHeaders,
  glabExecFileAsync,
  parseGlabAuthStatusHosts,
  release
} from './gl-utils'
import { rememberGlabKnownHosts } from './gitlab-known-host-probe'

const GITLAB_RATE_LIMIT_CACHE_TTL_MS = 30_000
const GITLAB_RATE_LIMIT_CACHE_MAX_ENTRIES = 64
const gitLabRateLimitCache = new Map<string, GitLabRateLimitSnapshot>()

export async function getAuthenticatedViewer(): Promise<GitLabViewer | null> {
  await acquire()
  try {
    const { stdout } = await glabExecFileAsync(['api', 'user'])
    const viewer = JSON.parse(stdout) as { username?: string; email?: string | null }
    if (!viewer.username?.trim()) {
      return null
    }
    return {
      username: viewer.username.trim(),
      email: viewer.email?.trim() || null
    }
  } catch {
    return null
  } finally {
    release()
  }
}

export async function diagnoseAuth(): Promise<GitLabAuthDiagnostic> {
  const envTokenInProcess = process.env.GITLAB_TOKEN
    ? 'GITLAB_TOKEN'
    : process.env.GLAB_TOKEN
      ? 'GLAB_TOKEN'
      : null
  try {
    // Why: a host-global diagnostic must not wake an unrelated default WSL distro.
    const { stdout, stderr } = await glabExecFileAsync(['auth', 'status'], {
      allowDefaultWslFallback: false
    })
    const output = `${stdout}\n${stderr}`
    const hosts = parseGlabAuthStatusHosts(output)
    // Why: refreshing auth must advance the provider cache key past a stale null result.
    rememberGlabKnownHosts(hosts)
    return {
      glabAvailable: true,
      authenticated:
        /logged in|authenticated|token/i.test(output) && !/not logged in/i.test(output),
      hosts,
      activeHost: hosts[0] ?? null,
      envTokenInProcess,
      error: null
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      glabAvailable: !/ENOENT|not found|spawn/i.test(message),
      authenticated: false,
      hosts: [],
      activeHost: null,
      envTokenInProcess,
      error: message
    }
  }
}

function parseRateLimitHeader(
  headers: Record<string, string>,
  keys: readonly string[]
): number | null {
  for (const key of keys) {
    const parsed = Number.parseInt(headers[key], 10)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return null
}

function parseRateLimitResetAt(headers: Record<string, string>): number | null {
  const numeric = parseRateLimitHeader(headers, ['ratelimit-reset', 'x-ratelimit-reset'])
  if (numeric !== null) {
    return numeric
  }
  const resetTime = headers['ratelimit-resettime'] ?? headers['x-ratelimit-resettime']
  if (!resetTime) {
    return null
  }
  const millis = Date.parse(resetTime)
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : null
}

function parseGitLabRateLimitSnapshot(
  headers: Record<string, string>,
  host: string | null
): GitLabRateLimitSnapshot {
  const limit = parseRateLimitHeader(headers, ['ratelimit-limit', 'x-ratelimit-limit'])
  const remaining = parseRateLimitHeader(headers, ['ratelimit-remaining', 'x-ratelimit-remaining'])
  const resetAt = parseRateLimitResetAt(headers)
  return {
    host,
    fetchedAt: Date.now(),
    rest:
      limit === null && remaining === null && resetAt === null
        ? null
        : {
            limit: limit ?? 0,
            remaining: remaining ?? 0,
            resetAt
          }
  }
}

/** @internal — test-only */
export function _resetGitLabRateLimitCache(): void {
  gitLabRateLimitCache.clear()
}

/** @internal — test-only */
export function _getGitLabRateLimitCacheSize(): number {
  return gitLabRateLimitCache.size
}

function pruneGitLabRateLimitCache(now = Date.now()): void {
  for (const [cacheKey, snapshot] of gitLabRateLimitCache) {
    if (now - snapshot.fetchedAt >= GITLAB_RATE_LIMIT_CACHE_TTL_MS) {
      gitLabRateLimitCache.delete(cacheKey)
    }
  }
  while (gitLabRateLimitCache.size > GITLAB_RATE_LIMIT_CACHE_MAX_ENTRIES) {
    const oldestKey = gitLabRateLimitCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    gitLabRateLimitCache.delete(oldestKey)
  }
}

function rememberGitLabRateLimitSnapshot(
  cacheKey: string,
  snapshot: GitLabRateLimitSnapshot
): void {
  pruneGitLabRateLimitCache()
  // Why: self-managed hostnames come from repo config; keep this cache bounded across many transient hosts.
  gitLabRateLimitCache.delete(cacheKey)
  gitLabRateLimitCache.set(cacheKey, snapshot)
  pruneGitLabRateLimitCache()
}

export async function getRateLimit(options?: {
  force?: boolean
  host?: string | null
}): Promise<GetGitLabRateLimitResult> {
  const host = options?.host?.trim() || null
  const cacheKey = host ?? 'default'
  pruneGitLabRateLimitCache()
  const cached = gitLabRateLimitCache.get(cacheKey)
  if (!options?.force && cached && Date.now() - cached.fetchedAt < GITLAB_RATE_LIMIT_CACHE_TTL_MS) {
    return { ok: true, snapshot: cached }
  }

  await acquire()
  try {
    // Why: GitLab exposes REST budget headers inconsistently; a null bucket means this host omitted them.
    const args = host ? ['--hostname', host, 'user'] : ['user']
    const { headers } = await glabApiWithHeaders(args)
    const snapshot = parseGitLabRateLimitSnapshot(headers, host)
    rememberGitLabRateLimitSnapshot(cacheKey, snapshot)
    return { ok: true, snapshot }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: message }
  } finally {
    release()
  }
}

/** Resolve a project's full GitLab project ref (host + path); null for non-GitLab remotes. */
