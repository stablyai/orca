import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listRepoWorktrees } from '../../../repo-worktrees'
import { registerWorktreeRootsForRepo } from '../../registered-worktree-roots-cache'

// Why: absorb renderer polling bursts while bounding external worktree-change lag to one short refresh window.
export const DETECTED_WORKTREE_SCAN_CACHE_TTL_MS = 5_000

export type DetectedWorktreeScanCacheEntry = {
  expiresAt: number
  worktrees: GitWorktreeInfo[]
}

export type DetectedWorktreeScan = {
  invalidated: boolean
  promise: Promise<GitWorktreeInfo[]>
}

export type DetectedWorktreeScanResult = {
  gitWorktrees: GitWorktreeInfo[]
  fresh: boolean
}

export const detectedWorktreeScanCache = new Map<string, DetectedWorktreeScanCacheEntry>()
export const detectedWorktreeScanInFlight = new Map<string, DetectedWorktreeScan>()

export function invalidateDetectedWorktreeScanCache(repoId: string): void {
  const keyPrefix = `${repoId}\0`
  for (const key of new Set([
    ...detectedWorktreeScanCache.keys(),
    ...detectedWorktreeScanInFlight.keys()
  ])) {
    if (!key.startsWith(keyPrefix)) {
      continue
    }
    detectedWorktreeScanCache.delete(key)
    const inFlight = detectedWorktreeScanInFlight.get(key)
    if (inFlight) {
      // Why: the detached scan keeps this token so later scans settle without making an older result fresh again.
      inFlight.invalidated = true
      detectedWorktreeScanInFlight.delete(key)
    }
  }
}

export function __resetDetectedWorktreeScanCacheForTests(): void {
  // Why: pending scans across a test reset must not repopulate the cache and leak state into the next test.
  for (const scan of detectedWorktreeScanInFlight.values()) {
    scan.invalidated = true
  }
  detectedWorktreeScanCache.clear()
  detectedWorktreeScanInFlight.clear()
}

export function __getDetectedWorktreeScanCacheStatsForTests(): {
  cacheSize: number
  inFlightSize: number
} {
  return {
    cacheSize: detectedWorktreeScanCache.size,
    inFlightSize: detectedWorktreeScanInFlight.size
  }
}

export async function listDetectedGitWorktrees(
  store: Store,
  repo: Repo
): Promise<DetectedWorktreeScanResult> {
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  if (repo.connectionId || isFolderRepo(repo)) {
    return {
      gitWorktrees: await listRepoWorktrees(repo, localWorktreeGitOptions),
      fresh: true
    }
  }

  const cacheKey = getDetectedWorktreeScanCacheKey(repo.id, localWorktreeGitOptions)
  const cached = detectedWorktreeScanCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return { gitWorktrees: cached.worktrees, fresh: false }
  }

  const inFlight = detectedWorktreeScanInFlight.get(cacheKey)
  if (inFlight) {
    return { gitWorktrees: await inFlight.promise, fresh: false }
  }

  const scan: DetectedWorktreeScan = {
    invalidated: false,
    promise: listRepoWorktrees(repo, localWorktreeGitOptions)
  }
  detectedWorktreeScanInFlight.set(cacheKey, scan)
  try {
    const gitWorktrees = await scan.promise
    // Why: a create/remove notification can invalidate mid-scan; don't let that stale scan repopulate the cache afterward.
    if (!scan.invalidated) {
      detectedWorktreeScanCache.set(cacheKey, {
        worktrees: gitWorktrees,
        expiresAt: Date.now() + DETECTED_WORKTREE_SCAN_CACHE_TTL_MS
      })
    }
    return { gitWorktrees, fresh: !scan.invalidated }
  } finally {
    if (detectedWorktreeScanInFlight.get(cacheKey) === scan) {
      detectedWorktreeScanInFlight.delete(cacheKey)
    }
  }
}

export function getDetectedWorktreeScanCacheKey(
  repoId: string,
  localWorktreeGitOptions: { wslDistro?: string } = {}
): string {
  return `${repoId}\0${localWorktreeGitOptions.wslDistro ?? 'host'}`
}

export function rememberLocalWorktreeRoots(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (repo.connectionId) {
    return
  }
  // Why: reuse the `git worktree list` result so later git/file IPC validation skips a second scan that can trigger macOS folder-permission prompts.
  registerWorktreeRootsForRepo(store, repo.id, [
    repo.path,
    ...gitWorktrees.map((worktree) => worktree.path)
  ])
}
