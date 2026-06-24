import { getEffectiveGitUpstreamStatus } from '../shared/git-effective-upstream'
import type { GitCommandRunner } from '../shared/git-effective-upstream'
import type { GitUpstreamStatus } from '../shared/types'

const NO_EFFECTIVE_UPSTREAM_CACHE_TTL_MS = 5 * 60_000
const MAX_NO_EFFECTIVE_UPSTREAM_CACHE_ENTRIES = 512

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
const retiredNoEffectiveUpstreamInFlight = new Map<string, Promise<GitUpstreamStatus>>()
const noEffectiveUpstreamWriteGeneration = new Map<string, number>()

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

function hasPendingNoEffectiveUpstreamProbe(cacheKey: string): boolean {
  return (
    noEffectiveUpstreamInFlight.has(cacheKey) || retiredNoEffectiveUpstreamInFlight.has(cacheKey)
  )
}

function trimNoEffectiveUpstreamWriteGeneration(): void {
  for (const cacheKey of noEffectiveUpstreamWriteGeneration.keys()) {
    if (noEffectiveUpstreamWriteGeneration.size <= MAX_NO_EFFECTIVE_UPSTREAM_CACHE_ENTRIES) {
      break
    }
    if (hasPendingNoEffectiveUpstreamProbe(cacheKey)) {
      continue
    }
    noEffectiveUpstreamWriteGeneration.delete(cacheKey)
  }
}

function cacheNoEffectiveUpstreamStatus(
  cacheKey: string,
  status: GitUpstreamStatus,
  probedSameNameOriginRef: boolean,
  writeGeneration: number,
  nowMs = Date.now()
): void {
  // Why: hasConfiguredPushTarget controls publish behavior; keep that signal
  // fresh rather than serving a stale positive from status polling.
  if (status.hasUpstream || status.hasConfiguredPushTarget) {
    noEffectiveUpstreamByIdentity.delete(cacheKey)
    noEffectiveUpstreamWriteGeneration.set(cacheKey, writeGeneration + 1)
    trimNoEffectiveUpstreamWriteGeneration()
    return
  }
  if ((noEffectiveUpstreamWriteGeneration.get(cacheKey) ?? 0) !== writeGeneration) {
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
  while (noEffectiveUpstreamByIdentity.size > MAX_NO_EFFECTIVE_UPSTREAM_CACHE_ENTRIES) {
    const oldest = noEffectiveUpstreamByIdentity.keys().next()
    if (oldest.done) {
      break
    }
    noEffectiveUpstreamByIdentity.delete(oldest.value)
    noEffectiveUpstreamWriteGeneration.delete(oldest.value)
  }
  trimNoEffectiveUpstreamWriteGeneration()
}

export async function readOrProbeNoEffectiveUpstreamStatus(
  identity: NoEffectiveUpstreamCacheIdentity,
  runGit: GitCommandRunner,
  options: { bypassCache?: boolean } = {}
): Promise<GitUpstreamStatus> {
  const cacheKey = noEffectiveUpstreamCacheKey(identity)
  if (options.bypassCache !== true) {
    const cachedStatus = readCachedNoEffectiveUpstreamStatus(cacheKey)
    if (cachedStatus) {
      return cachedStatus
    }

    const inFlight = noEffectiveUpstreamInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }
  }

  let probedSameNameOriginRef = false
  const writeGeneration = noEffectiveUpstreamWriteGeneration.get(cacheKey) ?? 0
  const probe = getEffectiveGitUpstreamStatus((args) => {
    if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${identity.branchName}`)) {
      probedSameNameOriginRef = true
    }
    return runGit(args)
  }).then((status) => {
    cacheNoEffectiveUpstreamStatus(cacheKey, status, probedSameNameOriginRef, writeGeneration)
    return status
  })
  if (options.bypassCache !== true) {
    noEffectiveUpstreamInFlight.set(cacheKey, probe)
  }
  try {
    return await probe
  } finally {
    if (noEffectiveUpstreamInFlight.get(cacheKey) === probe) {
      noEffectiveUpstreamInFlight.delete(cacheKey)
      trimNoEffectiveUpstreamWriteGeneration()
    }
  }
}

export function clearNoEffectiveUpstreamStatusCache(): void {
  noEffectiveUpstreamByIdentity.clear()
  noEffectiveUpstreamInFlight.clear()
  retiredNoEffectiveUpstreamInFlight.clear()
  noEffectiveUpstreamWriteGeneration.clear()
}

export function clearNoEffectiveUpstreamStatusCacheEntry(
  identity: NoEffectiveUpstreamCacheIdentity
): void {
  const cacheKey = noEffectiveUpstreamCacheKey(identity)
  retireNoEffectiveUpstreamProbe(cacheKey)
  noEffectiveUpstreamByIdentity.delete(cacheKey)
  noEffectiveUpstreamInFlight.delete(cacheKey)
  noEffectiveUpstreamWriteGeneration.set(
    cacheKey,
    (noEffectiveUpstreamWriteGeneration.get(cacheKey) ?? 0) + 1
  )
}

function retireNoEffectiveUpstreamProbe(cacheKey: string): void {
  const retiredProbe = noEffectiveUpstreamInFlight.get(cacheKey)
  if (!retiredProbe) {
    return
  }
  retiredNoEffectiveUpstreamInFlight.set(cacheKey, retiredProbe)
  void retiredProbe
    .finally(() => {
      if (retiredNoEffectiveUpstreamInFlight.get(cacheKey) === retiredProbe) {
        retiredNoEffectiveUpstreamInFlight.delete(cacheKey)
        trimNoEffectiveUpstreamWriteGeneration()
      }
    })
    .catch(() => undefined)
}

export function getNoEffectiveUpstreamStatusCacheCountForTests(): number {
  return noEffectiveUpstreamByIdentity.size
}

export function getNoEffectiveUpstreamStatusGenerationCountForTests(): number {
  return noEffectiveUpstreamWriteGeneration.size
}
