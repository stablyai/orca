import * as fsPromises from 'node:fs/promises'
import { win32 } from 'node:path'
import type { Stats } from 'node:fs'

type CachedRoute = { usesHostGit: boolean; expiresAt: number }
type TransientRouteFailure = { count: number; retryAfter: number }

// Bounds stale routing after delete/recreate while amortizing async parent walks on slow storage.
export const WSL_LINKED_WORKTREE_ROUTE_TTL_MS = 30_000
export const WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD = 512
export const WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS = 5_000
export const WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_PER_CWD = 2
export const WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL = 32
export const WSL_LINKED_WORKTREE_ROUTE_RETRY_BASE_MS = 1_000
const WSL_LINKED_WORKTREE_ROUTE_RETRY_MAX_MS = 30_000

const routeByCwd = new Map<string, CachedRoute>()
const pendingRoutes = new Map<string, Promise<boolean>>()
const transientFailuresByCwd = new Map<string, TransientRouteFailure>()
const activeProbeCountByCwd = new Map<string, number>()
let activeProbeCount = 0
let routeProbeGeneration = 0
let nextRoutePruneAt = 0

export function isWslLinkedWorktreeGitRoutingCandidate(
  cwd: string,
  wslDistro: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform === 'win32' && Boolean(wslDistro) && /^[A-Za-z]:[/\\]/.test(cwd)
}

function normalize(path: string): string {
  return win32.resolve(path)
}

function cachedRoute(cwd: string, now: number): boolean | undefined {
  const exact = routeByCwd.get(cwd)
  if (!exact) {
    return undefined
  }
  if (exact.expiresAt <= now) {
    routeByCwd.delete(cwd)
    return undefined
  }
  return exact.usesHostGit
}

export function parseWindowsLinkedGitdir(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.match(/^gitdir:\s*([A-Za-z]:[/\\].*?)\s*$/i)?.[1] ?? null
}

export type WslLinkedWorktreeRoutingFileSystem = {
  stat(path: string): Promise<Pick<Stats, 'isDirectory' | 'isFile'>>
  readFile(path: string): Promise<string>
}

export type WslLinkedWorktreeRoutingOptions = {
  platform?: NodeJS.Platform
  fileSystem?: WslLinkedWorktreeRoutingFileSystem
  now?: () => number
  signal?: AbortSignal
}

const defaultFileSystem: WslLinkedWorktreeRoutingFileSystem = {
  stat: (path) => fsPromises.stat(path),
  readFile: (path) => fsPromises.readFile(path, 'utf8')
}

async function shouldUseHostGit(
  cwd: string,
  fileSystem: WslLinkedWorktreeRoutingFileSystem
): Promise<boolean> {
  let candidate = cwd
  const driveRoot = win32.parse(candidate).root
  while (true) {
    const markerPath = win32.join(candidate, '.git')
    try {
      const marker = await fileSystem.stat(markerPath)
      if (marker.isDirectory()) {
        return false
      }
      if (marker.isFile()) {
        return parseWindowsLinkedGitdir(await fileSystem.readFile(markerPath)) !== null
      }
      return false
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
    }
    if (candidate === driveRoot) {
      return false
    }
    candidate = win32.dirname(candidate)
  }
}

function rememberRoute(cwd: string, usesHostGit: boolean, now: number): boolean {
  const expiresAt = now + WSL_LINKED_WORKTREE_ROUTE_TTL_MS
  if (
    routeByCwd.size >= WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD &&
    now >= nextRoutePruneAt
  ) {
    for (const [cachedCwd, route] of routeByCwd) {
      if (route.expiresAt <= now) {
        routeByCwd.delete(cachedCwd)
      }
    }
    nextRoutePruneAt = now + WSL_LINKED_WORKTREE_ROUTE_TTL_MS
  }
  routeByCwd.set(cwd, { usesHostGit, expiresAt })
  return usesHostGit
}

function routingAbortError(): Error {
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

function rememberTransientFailure(cwd: string, now: number): void {
  const count = (transientFailuresByCwd.get(cwd)?.count ?? 0) + 1
  const retryDelay =
    count === 1
      ? 0
      : Math.min(
          WSL_LINKED_WORKTREE_ROUTE_RETRY_BASE_MS * 2 ** Math.min(count - 2, 10),
          WSL_LINKED_WORKTREE_ROUTE_RETRY_MAX_MS
        )
  if (
    !transientFailuresByCwd.has(cwd) &&
    transientFailuresByCwd.size >= WSL_LINKED_WORKTREE_ROUTE_CACHE_PRUNE_THRESHOLD
  ) {
    const oldest = transientFailuresByCwd.keys().next().value
    if (oldest !== undefined) {
      transientFailuresByCwd.delete(oldest)
    }
  }
  transientFailuresByCwd.delete(cwd)
  transientFailuresByCwd.set(cwd, { count, retryAfter: now + retryDelay })
}

function canStartRouteProbe(cwd: string, now: number): boolean {
  const failure = transientFailuresByCwd.get(cwd)
  return Boolean(
    (!failure || failure.retryAfter <= now) &&
    (activeProbeCountByCwd.get(cwd) ?? 0) < WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_PER_CWD &&
    activeProbeCount < WSL_LINKED_WORKTREE_ROUTE_MAX_PROBES_TOTAL
  )
}

function trackRouteProbe(cwd: string): () => void {
  const generation = routeProbeGeneration
  activeProbeCount += 1
  activeProbeCountByCwd.set(cwd, (activeProbeCountByCwd.get(cwd) ?? 0) + 1)
  return () => {
    if (generation !== routeProbeGeneration) {
      return
    }
    activeProbeCount -= 1
    const remaining = (activeProbeCountByCwd.get(cwd) ?? 1) - 1
    if (remaining === 0) {
      activeProbeCountByCwd.delete(cwd)
    } else {
      activeProbeCountByCwd.set(cwd, remaining)
    }
  }
}

function waitForRouteUnlessAborted(
  route: Promise<boolean>,
  signal?: AbortSignal
): Promise<boolean> {
  if (!signal) {
    return route
  }
  if (signal.aborted) {
    return Promise.reject(routingAbortError())
  }
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(routingAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    route.then(
      (result) => {
        signal.removeEventListener('abort', onAbort)
        resolve(result)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

function discoverRoute(
  cwd: string,
  fileSystem: WslLinkedWorktreeRoutingFileSystem,
  now: () => number
): Promise<boolean> {
  return new Promise((resolve) => {
    const generation = routeProbeGeneration
    let settled = false
    const finish = (usesHostGit: boolean, cacheable: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (generation !== routeProbeGeneration) {
        resolve(false)
        return
      }
      if (cacheable) {
        transientFailuresByCwd.delete(cwd)
        resolve(rememberRoute(cwd, usesHostGit, now()))
      } else {
        rememberTransientFailure(cwd, now())
        resolve(usesHostGit)
      }
    }
    const timer = setTimeout(() => finish(false, false), WSL_LINKED_WORKTREE_ROUTE_PROBE_TIMEOUT_MS)
    timer.unref()
    const releaseProbe = trackRouteProbe(cwd)
    void shouldUseHostGit(cwd, fileSystem).then(
      (usesHostGit) => {
        releaseProbe()
        finish(usesHostGit, true)
      },
      () => {
        releaseProbe()
        finish(false, false)
      }
    )
  })
}

export async function prepareWslLinkedWorktreeGitRouting(
  cwd: string,
  wslDistro: string | undefined,
  options: WslLinkedWorktreeRoutingOptions = {}
): Promise<boolean> {
  const platform = options.platform ?? process.platform
  const fileSystem = options.fileSystem ?? defaultFileSystem
  const now = options.now ?? Date.now
  if (!isWslLinkedWorktreeGitRoutingCandidate(cwd, wslDistro, platform)) {
    return false
  }
  if (options.signal?.aborted) {
    throw routingAbortError()
  }
  const normalizedCwd = normalize(cwd)
  const cached = cachedRoute(normalizedCwd, now())
  if (cached !== undefined) {
    return cached
  }
  const pending = pendingRoutes.get(normalizedCwd)
  if (pending) {
    return waitForRouteUnlessAborted(pending, options.signal)
  }
  if (!canStartRouteProbe(normalizedCwd, now())) {
    return false
  }
  const discovery = discoverRoute(normalizedCwd, fileSystem, now)
  const route = discovery.finally(() => {
    if (pendingRoutes.get(normalizedCwd) === route) {
      pendingRoutes.delete(normalizedCwd)
    }
  })
  pendingRoutes.set(normalizedCwd, route)
  return waitForRouteUnlessAborted(route, options.signal)
}

export function usesHostGitForWslLinkedWorktree(
  cwd: string,
  wslDistro: string | undefined,
  platform: NodeJS.Platform = process.platform,
  now: () => number = Date.now
): boolean {
  return (
    isWslLinkedWorktreeGitRoutingCandidate(cwd, wslDistro, platform) &&
    cachedRoute(normalize(cwd), now()) === true
  )
}

export function resetWslLinkedWorktreeGitRoutingForTests(): void {
  routeByCwd.clear()
  pendingRoutes.clear()
  transientFailuresByCwd.clear()
  activeProbeCountByCwd.clear()
  activeProbeCount = 0
  routeProbeGeneration += 1
  nextRoutePruneAt = 0
}

export function seedWslLinkedWorktreeGitRoutingForTests(root: string): void {
  const normalizedRoot = normalize(root)
  routeByCwd.set(normalizedRoot, {
    usesHostGit: true,
    expiresAt: Number.POSITIVE_INFINITY
  })
}
