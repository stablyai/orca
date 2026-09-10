import type { GitUpstreamStatus } from '../../../shared/git-status-types'
import {
  getEffectiveGitUpstreamStatus,
  getGitUpstreamStatusForUpstreamName,
  splitRemoteBranchName
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
  branchName: string,
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
    branchName,
    options,
    bypassCache
  ).then((result) => {
    rememberEffectiveUpstreamStatus(
      cacheKey,
      result.status,
      Date.now(),
      result.probedSameNameOriginRef,
      writeGeneration
    )
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
  branchName: string,
  options: GitRuntimeOptions = {},
  bypassCache = false
): Promise<{ status: GitUpstreamStatus; probedSameNameOriginRef: boolean }> {
  const now = Date.now()
  const cached = resolvedUpstreamNameCache.get(cacheKey)
  if (cached && (bypassCache || cached.expiresAt <= now)) {
    resolvedUpstreamNameCache.delete(cacheKey)
  } else if (cached) {
    try {
      const status = await getGitUpstreamStatusForUpstreamName(
        (args) => gitExecFileAsync(args, gitReadOptionsForWorktree(worktreePath, options)),
        cached.upstreamName
      )
      return { status, probedSameNameOriginRef: false }
    } catch (error) {
      // Why: an aborted probe says nothing about the ref; don't evict the warm name cache.
      if (options.signal?.aborted) {
        throw error
      }
      // Ref deleted or repo state changed — fall through to a full re-resolve.
      resolvedUpstreamNameCache.delete(cacheKey)
    }
  }
  const result = await probeEffectiveUpstreamStatus(worktreePath, branchName, options)
  if (result.status.hasUpstream && result.status.upstreamName) {
    resolvedUpstreamNameCache.set(cacheKey, {
      upstreamName: result.status.upstreamName,
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
  branchName: string,
  options: GitRuntimeOptions = {}
): Promise<{ status: GitUpstreamStatus; probedSameNameOriginRef: boolean }> {
  let probedSameNameOriginRef = false
  const snapshotRunner = createGitConfigSnapshotRunner((args) =>
    gitExecFileAsync(args, gitReadOptionsForWorktree(worktreePath, options))
  )
  const status = await getEffectiveGitUpstreamStatus((args) => {
    if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
      probedSameNameOriginRef = true
    }
    return snapshotRunner(args)
  })
  return { status, probedSameNameOriginRef }
}

export function shouldProbeEffectiveUpstreamStatus(
  branch: string | undefined,
  upstreamName: string | undefined
): boolean {
  const branchName = getShortBranchName(branch)
  if (!branchName) {
    return false
  }
  if (!upstreamName) {
    return true
  }
  const parsed = splitRemoteBranchName(upstreamName)
  return parsed?.remoteName === 'origin' && parsed.branchName !== branchName
}
