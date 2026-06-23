import { getEffectiveGitUpstreamStatus } from '../shared/git-effective-upstream'
import type { GitCommandRunner } from '../shared/git-effective-upstream'
import type { GitUpstreamStatus } from '../shared/types'

const NO_EFFECTIVE_UPSTREAM_CACHE_TTL_MS = 30_000

type NoEffectiveUpstreamCacheIdentity = {
  worktreePath: string
  branchName: string
  upstreamName?: string
}

type NoEffectiveUpstreamCacheEntry = {
  status: GitUpstreamStatus
  expiresAt: number
}

const noEffectiveUpstreamByIdentity = new Map<string, NoEffectiveUpstreamCacheEntry>()
const noEffectiveUpstreamInFlight = new Map<string, Promise<GitUpstreamStatus>>()

function noEffectiveUpstreamCacheKey(identity: NoEffectiveUpstreamCacheIdentity): string {
  return [identity.worktreePath, identity.branchName, identity.upstreamName ?? ''].join('\0')
}

function readCachedNoEffectiveUpstreamStatus(
  cacheKey: string,
  nowMs = Date.now()
): GitUpstreamStatus | null {
  const entry = noEffectiveUpstreamByIdentity.get(cacheKey)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= nowMs) {
    noEffectiveUpstreamByIdentity.delete(cacheKey)
    return null
  }
  return entry.status
}

function cacheNoEffectiveUpstreamStatus(
  cacheKey: string,
  status: GitUpstreamStatus,
  probedSameNameOriginRef: boolean,
  nowMs = Date.now()
): void {
  // Why: hasConfiguredPushTarget controls publish behavior; keep that signal
  // fresh rather than serving a stale positive from status polling.
  if (status.hasUpstream || status.hasConfiguredPushTarget) {
    noEffectiveUpstreamByIdentity.delete(cacheKey)
    return
  }
  // Why: only cache negatives after probing origin/<branch>; other resolution
  // paths can fail without proving the same-name publish branch is absent.
  if (!probedSameNameOriginRef) {
    return
  }
  noEffectiveUpstreamByIdentity.set(cacheKey, {
    status,
    expiresAt: nowMs + NO_EFFECTIVE_UPSTREAM_CACHE_TTL_MS
  })
}

export async function readOrProbeNoEffectiveUpstreamStatus(
  identity: NoEffectiveUpstreamCacheIdentity,
  runGit: GitCommandRunner
): Promise<GitUpstreamStatus> {
  const cacheKey = noEffectiveUpstreamCacheKey(identity)
  const cachedStatus = readCachedNoEffectiveUpstreamStatus(cacheKey)
  if (cachedStatus) {
    return cachedStatus
  }

  const inFlight = noEffectiveUpstreamInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }

  let probedSameNameOriginRef = false
  const probe = getEffectiveGitUpstreamStatus((args) => {
    if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${identity.branchName}`)) {
      probedSameNameOriginRef = true
    }
    return runGit(args)
  }).then((status) => {
    cacheNoEffectiveUpstreamStatus(cacheKey, status, probedSameNameOriginRef)
    return status
  })
  noEffectiveUpstreamInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (noEffectiveUpstreamInFlight.get(cacheKey) === probe) {
      noEffectiveUpstreamInFlight.delete(cacheKey)
    }
  }
}

export function clearNoEffectiveUpstreamStatusCache(): void {
  noEffectiveUpstreamByIdentity.clear()
  noEffectiveUpstreamInFlight.clear()
}
