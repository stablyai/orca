import type { AiVaultScanIssue, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { CursorSidecarEvidence } from './session-scanner-cursor-sidecar'
import { materializeCursorSession } from './session-scanner-cursor-materialize'
import { cursorSidecarBucket } from './session-scanner-cursor-paths'
import type { CursorCwdEvidence, CursorLayout, FileWithMtime } from './session-scanner-types'

export type ParsedCursorCandidate = {
  layout: CursorLayout
  storageContextKey: string
  file: FileWithMtime
  cwdEvidence?: CursorCwdEvidence
  sidecar?: CursorSidecarEvidence | null
  legacy?: AiVaultSession | null
}

export type CursorReconcileStats = {
  suppressedSubagents: number
  falseOnlyGroups: number
  reconciledCounterparts: number
  ambiguousLegacyIds: number
  bucketCollisions: number
}

export type CursorPhysicalGroup = {
  storageContextKey: string
  sessionId: string
  candidates: ParsedCursorCandidate[]
  bucketCollision?: string
  legacyPathCollision?: string
}

export function reconcileCursorCandidates(args: {
  candidates: readonly ParsedCursorCandidate[]
  executionHostId: ExecutionHostId
  platform: NodeJS.Platform
  issues: AiVaultScanIssue[]
  commandOverride?: string | null
}): {
  sessions: AiVaultSession[]
  scopedSessionIds: ReadonlySet<string>
  stats: CursorReconcileStats
} {
  const stats: CursorReconcileStats = {
    suppressedSubagents: 0,
    falseOnlyGroups: 0,
    reconciledCounterparts: 0,
    ambiguousLegacyIds: 0,
    bucketCollisions: 0
  }
  const groups = buildPhysicalGroups(args.candidates, args.platform, { ...args, stats })
  const sessions: AiVaultSession[] = []
  const scopedSessionIds = new Set<string>()
  for (const group of groups) {
    const session = materializeCursorSession({ ...args, group, stats })
    if (!session) {
      continue
    }
    sessions.push(session)
    if (group.candidates.some((candidate) => candidate.cwdEvidence?.kind === 'scope-bucket')) {
      scopedSessionIds.add(session.id)
    }
  }
  return { sessions, scopedSessionIds, stats }
}

function buildPhysicalGroups(
  candidates: readonly ParsedCursorCandidate[],
  platform: NodeJS.Platform,
  issueContext: {
    executionHostId: ExecutionHostId
    issues: AiVaultScanIssue[]
    stats: CursorReconcileStats
  }
): CursorPhysicalGroup[] {
  const logicalGroups = new Map<string, ParsedCursorCandidate[]>()
  for (const candidate of candidates) {
    const sessionId = candidate.sidecar?.sessionId ?? candidate.legacy?.sessionId
    if (!sessionId) {
      continue
    }
    const key = `${candidate.storageContextKey}\0${sessionId}`
    logicalGroups.set(key, [...(logicalGroups.get(key) ?? []), candidate])
  }

  const groups: CursorPhysicalGroup[] = []
  for (const candidatesForId of logicalGroups.values()) {
    const first = candidatesForId[0]
    const sessionId = first.sidecar?.sessionId ?? first.legacy?.sessionId
    if (!sessionId) {
      continue
    }
    const sidecarsByBucket = new Map<string, ParsedCursorCandidate[]>()
    const legacy = candidatesForId.filter((candidate) => candidate.legacy)
    for (const candidate of candidatesForId) {
      if (!candidate.sidecar) {
        continue
      }
      const bucket = cursorSidecarBucket(candidate.file.path, platform)
      if (bucket) {
        sidecarsByBucket.set(bucket, [...(sidecarsByBucket.get(bucket) ?? []), candidate])
      }
    }

    const bucketCollision = sidecarsByBucket.size > 1
    if (bucketCollision) {
      issueContext.stats.bucketCollisions++
      issueContext.issues.push({
        executionHostId: issueContext.executionHostId,
        agent: 'cursor',
        path: `cursor:${sessionId}`,
        message: 'Cursor session id exists in multiple storage buckets.'
      })
    }
    const legacyByBucket = assignLegacyCandidatesToBuckets(legacy, sidecarsByBucket)
    for (const [bucket, sidecars] of sidecarsByBucket) {
      groups.push({
        storageContextKey: first.storageContextKey,
        sessionId,
        candidates: [...sidecars, ...(legacyByBucket.get(bucket) ?? [])],
        ...(bucketCollision ? { bucketCollision: bucket } : {})
      })
    }

    if (sidecarsByBucket.size === 0) {
      appendLegacyOnlyGroups(groups, first.storageContextKey, sessionId, legacy)
    } else {
      const assigned = new Set([...legacyByBucket.values()].flat())
      const unresolved = legacy.filter((candidate) => !assigned.has(candidate))
      if (unresolved.length === 0) {
        continue
      }
      issueContext.stats.ambiguousLegacyIds++
      issueContext.issues.push({
        executionHostId: issueContext.executionHostId,
        agent: 'cursor',
        path: `cursor:${sessionId}`,
        message: 'Cursor legacy transcript has an ambiguous storage bucket.'
      })
      appendLegacyOnlyGroups(
        groups,
        first.storageContextKey,
        sessionId,
        unresolved,
        sidecarsByBucket.size > 1
      )
    }
  }
  return groups
}

function assignLegacyCandidatesToBuckets(
  legacy: readonly ParsedCursorCandidate[],
  sidecarsByBucket: ReadonlyMap<string, ParsedCursorCandidate[]>
): Map<string, ParsedCursorCandidate[]> {
  const assigned = new Map<string, ParsedCursorCandidate[]>()
  if (sidecarsByBucket.size === 1) {
    const bucket = sidecarsByBucket.keys().next().value as string
    assigned.set(bucket, [...legacy])
    return assigned
  }
  for (const candidate of legacy) {
    const bucket = candidate.cwdEvidence?.bucket
    if (!bucket) {
      continue
    }
    const sidecars = sidecarsByBucket.get(bucket)
    if (
      sidecars &&
      candidate.cwdEvidence?.kind === 'legacy-scope-only' &&
      sidecars.some(
        (sidecar) =>
          sidecar.cwdEvidence?.kind === 'scope-bucket' && sidecar.cwdEvidence.bucket === bucket
      )
    ) {
      assigned.set(bucket, [...(assigned.get(bucket) ?? []), candidate])
    }
  }
  return assigned
}

function appendLegacyOnlyGroups(
  groups: CursorPhysicalGroup[],
  storageContextKey: string,
  sessionId: string,
  legacy: readonly ParsedCursorCandidate[],
  forcePathCollision = false
): void {
  if (legacy.length === 1 && !forcePathCollision) {
    groups.push({ storageContextKey, sessionId, candidates: [legacy[0]] })
    return
  }
  for (const candidate of legacy) {
    groups.push({
      storageContextKey,
      sessionId,
      candidates: [candidate],
      legacyPathCollision: candidate.file.path
    })
  }
}
