import { sessionIdFromFileName, sessionSortTime } from './session-scanner-accumulator'
import {
  cursorSessionActivityMtimeMs,
  cursorSidecarBucket,
  cursorSidecarSessionId
} from './session-scanner-cursor-paths'
import type { CursorCwdEvidence, CursorLayout, FileWithMtime } from './session-scanner-types'
import type { AiVaultSession } from '../../shared/ai-vault-types'

export type CursorCandidateSelectionGroup<T> = {
  candidates: T[]
  key: string
  mtimeMs: number
  scoped: boolean
  scopePriority: number
}

type CursorSelectionAdapter<T> = {
  getCwdEvidence(candidate: T): CursorCwdEvidence | undefined
  getFile(candidate: T): FileWithMtime
  getLayout(candidate: T): CursorLayout
  getStorageContextKey(candidate: T): string
}

type CursorSelectionIdentity<T> = {
  candidate: T
  contextKey: string
  cwdEvidence?: CursorCwdEvidence
  file: FileWithMtime
  layout: CursorLayout
  logicalKey: string
  sessionId: string
  sidecarBucket: string | null
}

export function buildCursorCandidateSelectionGroups<T>(args: {
  candidates: readonly T[]
  platform: NodeJS.Platform
  adapter: CursorSelectionAdapter<T>
}): CursorCandidateSelectionGroup<T>[] {
  const identities = args.candidates
    .map((candidate) => cursorSelectionIdentity(candidate, args.platform, args.adapter))
    .filter((identity): identity is CursorSelectionIdentity<T> => Boolean(identity))
  const sidecarBucketsByLogicalKey = new Map<string, Set<string>>()
  const scopedSidecarBucketsByLogicalKey = new Map<string, Set<string>>()
  for (const identity of identities) {
    if (identity.layout !== 'sidecar' || !identity.sidecarBucket) {
      continue
    }
    addToSetMap(sidecarBucketsByLogicalKey, identity.logicalKey, identity.sidecarBucket)
    if (identity.cwdEvidence?.kind === 'scope-bucket') {
      addToSetMap(scopedSidecarBucketsByLogicalKey, identity.logicalKey, identity.sidecarBucket)
    }
  }

  const groups = new Map<string, CursorCandidateSelectionGroup<T>>()
  for (const identity of identities) {
    const key = selectionKey(
      identity,
      sidecarBucketsByLogicalKey.get(identity.logicalKey),
      scopedSidecarBucketsByLogicalKey.get(identity.logicalKey)
    )
    const existing = groups.get(key)
    if (existing) {
      existing.candidates.push(identity.candidate)
      existing.mtimeMs = Math.max(existing.mtimeMs, cursorSessionActivityMtimeMs(identity.file))
      existing.scoped ||= Boolean(identity.cwdEvidence)
      existing.scopePriority = Math.max(
        existing.scopePriority,
        cursorScopePriority(identity.cwdEvidence)
      )
      continue
    }
    groups.set(key, {
      candidates: [identity.candidate],
      key,
      mtimeMs: cursorSessionActivityMtimeMs(identity.file),
      scoped: Boolean(identity.cwdEvidence),
      scopePriority: cursorScopePriority(identity.cwdEvidence)
    })
  }
  return [...groups.values()].sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.key.localeCompare(right.key)
  )
}

export function selectCursorScopedGroups<T>(
  groups: readonly CursorCandidateSelectionGroup<T>[],
  processedGroups: ReadonlySet<CursorCandidateSelectionGroup<T>>,
  limit: number
): CursorCandidateSelectionGroup<T>[] {
  return groups
    .filter((group) => group.scoped && !processedGroups.has(group))
    .sort(
      (left, right) =>
        right.scopePriority - left.scopePriority ||
        right.mtimeMs - left.mtimeMs ||
        left.key.localeCompare(right.key)
    )
    .slice(0, limit)
}

export function canStopCursorGroupSelection(
  sessions: readonly AiVaultSession[],
  limit: number,
  nextGroupMtimeMs: number | undefined
): boolean {
  if (sessions.length < limit || typeof nextGroupMtimeMs !== 'number') {
    return false
  }
  const cutoff = [...sessions]
    .map(sessionSortTime)
    .sort((left, right) => right - left)
    .at(limit - 1)
  return typeof cutoff === 'number' && nextGroupMtimeMs < cutoff
}

function cursorSelectionIdentity<T>(
  candidate: T,
  platform: NodeJS.Platform,
  adapter: CursorSelectionAdapter<T>
): CursorSelectionIdentity<T> | null {
  const file = adapter.getFile(candidate)
  const layout = adapter.getLayout(candidate)
  const sessionId =
    layout === 'sidecar'
      ? cursorSidecarSessionId(file.path, platform)
      : sessionIdFromFileName(file.path)
  if (!sessionId) {
    return null
  }
  const contextKey = adapter.getStorageContextKey(candidate)
  return {
    candidate,
    contextKey,
    cwdEvidence: adapter.getCwdEvidence(candidate),
    file,
    layout,
    logicalKey: `${contextKey}\0${sessionId}`,
    sessionId,
    sidecarBucket: layout === 'sidecar' ? cursorSidecarBucket(file.path, platform) : null
  }
}

function selectionKey<T>(
  identity: CursorSelectionIdentity<T>,
  sidecarBuckets: ReadonlySet<string> | undefined,
  scopedSidecarBuckets: ReadonlySet<string> | undefined
): string {
  if (identity.layout === 'sidecar') {
    return `sidecar\0${identity.logicalKey}`
  }
  if (sidecarBuckets?.size === 1) {
    return `sidecar\0${identity.logicalKey}`
  }
  const evidenceBucket = identity.cwdEvidence?.bucket
  if (
    identity.cwdEvidence?.kind === 'legacy-scope-only' &&
    evidenceBucket &&
    sidecarBuckets?.has(evidenceBucket) &&
    scopedSidecarBuckets?.has(evidenceBucket)
  ) {
    return `sidecar\0${identity.logicalKey}`
  }
  return `legacy\0${identity.logicalKey}\0${identity.file.path}`
}

function addToSetMap(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>()
  values.add(value)
  map.set(key, values)
}

function cursorScopePriority(evidence: CursorCwdEvidence | undefined): number {
  return evidence?.kind === 'scope-bucket' ? 2 : evidence ? 1 : 0
}
