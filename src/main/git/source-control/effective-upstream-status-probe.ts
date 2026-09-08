import type { GitUpstreamStatus } from '../../../shared/git-status-types'
import {
  getEffectiveGitUpstreamStatus,
  getGitUpstreamStatusForIdentity
} from '../../../shared/git-effective-upstream'
import { createGitConfigSnapshotRunner } from '../../../shared/git-config-snapshot-runner'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import {
  MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES,
  effectiveUpstreamStatusInFlight,
  effectiveUpstreamStatusWriteGeneration,
  readCachedEffectiveUpstreamStatus,
  rememberEffectiveUpstreamStatus,
  trimEffectiveUpstreamStatusGeneration
} from './effective-upstream-status-cache'
import {
  RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS,
  resolvedUpstreamNameCache
} from './resolved-upstream-name-cache'

export function getShortBranchName(branch: string | undefined): string | null {
  const prefix = 'refs/heads/'
  return branch?.startsWith(prefix) ? branch.slice(prefix.length) : null
}

export async function readOrProbeEffectiveUpstreamStatus(
  cacheKey: string,
  worktreePath: string,
  _branchName: string,
  options: GitRuntimeOptions = {},
  bypassCache = false
): Promise<GitUpstreamStatus> {
  if (!bypassCache) {
    const cached = readCachedEffectiveUpstreamStatus(cacheKey, Date.now())
    if (cached) {
      return cached
    }

    const inFlight = effectiveUpstreamStatusInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }
  }

  // Why: overlapping refreshes at startup — coalesce the upstream probe so a stable missing ref fails once.
  const writeGeneration = effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0
  const probe = probeOrRevalidateEffectiveUpstreamStatus(
    cacheKey,
    worktreePath,
    options,
    bypassCache
  ).then((result) => {
    rememberEffectiveUpstreamStatus(cacheKey, result.status, Date.now(), writeGeneration)
    return result.status
  })
  if (!bypassCache) {
    effectiveUpstreamStatusInFlight.set(cacheKey, probe)
  }
  try {
    return await probe
  } finally {
    if (effectiveUpstreamStatusInFlight.get(cacheKey) === probe) {
      effectiveUpstreamStatusInFlight.delete(cacheKey)
      trimEffectiveUpstreamStatusGeneration()
    }
  }
}

async function probeOrRevalidateEffectiveUpstreamStatus(
  cacheKey: string,
  worktreePath: string,
  options: GitRuntimeOptions = {},
  bypassCache = false
): Promise<{ status: GitUpstreamStatus }> {
  const now = Date.now()
  const cached = resolvedUpstreamNameCache.get(cacheKey)
  if (cached && (bypassCache || cached.expiresAt <= now)) {
    resolvedUpstreamNameCache.delete(cacheKey)
  } else if (cached) {
    try {
      const status = await getGitUpstreamStatusForIdentity(
        (args) => gitExecFileAsync(args, gitReadOptionsForWorktree(worktreePath, options)),
        cached.upstreamIdentity
      )
      return { status }
    } catch (error) {
      // Why: an aborted probe says nothing about the ref; don't evict the warm name cache.
      if (options.signal?.aborted) {
        throw error
      }
      // Ref deleted or repo state changed — fall through to a full re-resolve.
      resolvedUpstreamNameCache.delete(cacheKey)
    }
  }
  const result = await probeEffectiveUpstreamStatus(worktreePath, options)
  if (
    result.status.hasUpstream &&
    result.status.upstreamName &&
    result.status.upstreamIdentity?.trackingRef
  ) {
    resolvedUpstreamNameCache.set(cacheKey, {
      upstreamIdentity: {
        ...result.status.upstreamIdentity,
        trackingRef: result.status.upstreamIdentity.trackingRef
      },
      expiresAt: Date.now() + RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS
    })
    while (resolvedUpstreamNameCache.size > MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES) {
      const oldest = resolvedUpstreamNameCache.keys().next()
      if (oldest.done) {
        break
      }
      resolvedUpstreamNameCache.delete(oldest.value)
    }
  }
  return result
}

async function probeEffectiveUpstreamStatus(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<{ status: GitUpstreamStatus }> {
  const snapshotRunner = createGitConfigSnapshotRunner((args) =>
    gitExecFileAsync(args, gitReadOptionsForWorktree(worktreePath, options))
  )
  const status = await getEffectiveGitUpstreamStatus(snapshotRunner)
  return { status }
}

export function shouldProbeEffectiveUpstreamStatus(
  branch: string | undefined,
  _upstreamName?: string
): boolean {
  // Porcelain upstream labels cannot authorize skipping canonical operation policy.
  return getShortBranchName(branch) !== null
}
