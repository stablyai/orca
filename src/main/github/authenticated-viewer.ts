import type { GitHubViewer } from '../../shared/types'
import { acquire, ghExecFileAsync, release } from './gh-utils'

type GitHubViewerExecutionOptions = {
  cwd?: string
  force?: boolean
  host?: string
  wslDistro?: string
}

const POSITIVE_TTL_MS = 30_000
const NEGATIVE_TTL_MS = 5_000
const CACHE_MAX_ENTRIES = 32

const cache = new Map<string, { value: GitHubViewer | null; expiresAt: number }>()
const inFlight = new Map<string, Promise<GitHubViewer | null>>()

function cacheKey(options: GitHubViewerExecutionOptions): string {
  const runtime = options.wslDistro
    ? `wsl:${options.wslDistro.toLowerCase()}`
    : `native:${process.env.GH_CONFIG_DIR ?? ''}`
  const host =
    options.host?.trim().toLowerCase() || process.env.GH_HOST?.trim().toLowerCase() || 'github.com'
  return `${runtime}\0${host}`
}

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key)
    }
  }
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}

async function queryAuthenticatedViewer(
  options: GitHubViewerExecutionOptions
): Promise<GitHubViewer | null> {
  await acquire()
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', 'user', '--jq', '{login: .login, email: .email}'],
      { ...options, encoding: 'utf-8' }
    )
    const viewer = JSON.parse(stdout) as { login?: string; email?: string | null }
    if (!viewer.login?.trim()) {
      return null
    }
    return {
      login: viewer.login.trim(),
      email: viewer.email?.trim() || null
    }
  } catch {
    return null
  } finally {
    release()
  }
}

export function getAuthenticatedViewer(
  options: GitHubViewerExecutionOptions = {}
): Promise<GitHubViewer | null> {
  const { force = false, ...executionOptions } = options
  const key = cacheKey(executionOptions)
  const now = Date.now()
  pruneCache(now)
  const cached = cache.get(key)
  if (!force && cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value)
  }
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const request = queryAuthenticatedViewer(executionOptions).then((viewer) => {
    cache.set(key, {
      value: viewer,
      expiresAt: Date.now() + (viewer ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS)
    })
    pruneCache(Date.now())
    return viewer
  })
  inFlight.set(key, request)
  void request.finally(() => {
    if (inFlight.get(key) === request) {
      inFlight.delete(key)
    }
  })
  return request
}

export function _resetAuthenticatedViewerCache(): void {
  cache.clear()
  inFlight.clear()
}

export function _getAuthenticatedViewerCacheSize(): number {
  return cache.size
}
