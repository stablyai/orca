import type {
  DiffReviewScope,
  MobileDiffReviewFileState,
  MobileDiffReviewState
} from '../../../src/shared/types'

export type MobileDiffReviewFileDescriptor = {
  key: string
  filePath: string
  oldPath?: string
  scope: DiffReviewScope
  diffIdentity: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeScope(value: unknown): DiffReviewScope | null {
  return value === 'unstaged' || value === 'staged' || value === 'branch' ? value : null
}

function normalizeFileState(key: string, value: unknown): MobileDiffReviewFileState | null {
  if (!isRecord(value)) {
    return null
  }
  const filePath = typeof value.filePath === 'string' ? value.filePath : ''
  const scope = normalizeScope(value.scope)
  if (!filePath || !scope) {
    return null
  }
  return {
    key: typeof value.key === 'string' && value.key ? value.key : key,
    filePath,
    oldPath: typeof value.oldPath === 'string' ? value.oldPath : undefined,
    scope,
    lastOpenedAt: typeof value.lastOpenedAt === 'number' ? value.lastOpenedAt : undefined,
    lastSeenDiffIdentity:
      typeof value.lastSeenDiffIdentity === 'string' ? value.lastSeenDiffIdentity : undefined,
    reviewedAt: typeof value.reviewedAt === 'number' ? value.reviewedAt : undefined,
    reviewDiffIdentity:
      typeof value.reviewDiffIdentity === 'string' ? value.reviewDiffIdentity : undefined
  }
}

export function normalizeMobileDiffReviewState(value: unknown): MobileDiffReviewState {
  if (!isRecord(value) || !isRecord(value.files)) {
    return { version: 1, files: {} }
  }
  const files: Record<string, MobileDiffReviewFileState> = {}
  for (const [key, candidate] of Object.entries(value.files)) {
    const state = normalizeFileState(key, candidate)
    if (state) {
      files[state.key] = state
    }
  }
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : undefined,
    completedAt: typeof value.completedAt === 'number' ? value.completedAt : undefined,
    files
  }
}

export function createMobileDiffReviewState(now: number): MobileDiffReviewState {
  return { version: 1, updatedAt: now, files: {} }
}

export function mergeMobileDiffReviewState(
  state: MobileDiffReviewState,
  descriptors: readonly MobileDiffReviewFileDescriptor[],
  now: number
): MobileDiffReviewState {
  const files: Record<string, MobileDiffReviewFileState> = { ...state.files }
  let invalidatedReview = false
  for (const descriptor of descriptors) {
    const previous = files[descriptor.key]
    const changedSinceReview =
      previous?.reviewedAt !== undefined &&
      previous.reviewDiffIdentity !== undefined &&
      previous.reviewDiffIdentity !== descriptor.diffIdentity
    if (changedSinceReview) {
      invalidatedReview = true
    }
    files[descriptor.key] = {
      key: descriptor.key,
      filePath: descriptor.filePath,
      oldPath: descriptor.oldPath,
      scope: descriptor.scope,
      lastOpenedAt: previous?.lastOpenedAt,
      lastSeenDiffIdentity: previous?.lastSeenDiffIdentity,
      reviewedAt: changedSinceReview ? undefined : previous?.reviewedAt,
      reviewDiffIdentity: changedSinceReview ? undefined : previous?.reviewDiffIdentity
    }
  }
  // Why: a file whose diff changed is no longer reviewed, so a prior "review
  // complete" marker is stale — match markUnreviewed and drop completedAt.
  return {
    ...state,
    version: 1,
    updatedAt: now,
    completedAt: invalidatedReview ? undefined : state.completedAt,
    files
  }
}

export function markMobileDiffReviewFileOpened(
  state: MobileDiffReviewState,
  descriptor: MobileDiffReviewFileDescriptor,
  now: number
): MobileDiffReviewState {
  const previous = state.files[descriptor.key]
  return {
    ...state,
    updatedAt: now,
    files: {
      ...state.files,
      [descriptor.key]: {
        key: descriptor.key,
        filePath: descriptor.filePath,
        oldPath: descriptor.oldPath,
        scope: descriptor.scope,
        reviewedAt: previous?.reviewedAt,
        reviewDiffIdentity: previous?.reviewDiffIdentity,
        lastOpenedAt: now,
        lastSeenDiffIdentity: descriptor.diffIdentity
      }
    }
  }
}

export function markMobileDiffReviewFileReviewed(
  state: MobileDiffReviewState,
  descriptor: MobileDiffReviewFileDescriptor,
  now: number
): MobileDiffReviewState {
  return {
    ...state,
    updatedAt: now,
    files: {
      ...state.files,
      [descriptor.key]: {
        key: descriptor.key,
        filePath: descriptor.filePath,
        oldPath: descriptor.oldPath,
        scope: descriptor.scope,
        lastOpenedAt: state.files[descriptor.key]?.lastOpenedAt,
        lastSeenDiffIdentity: descriptor.diffIdentity,
        reviewedAt: now,
        reviewDiffIdentity: descriptor.diffIdentity
      }
    }
  }
}

export function clearMobileDiffReviewFileReviewed(
  state: MobileDiffReviewState,
  key: string,
  now: number
): MobileDiffReviewState {
  const previous = state.files[key]
  if (!previous) {
    return state
  }
  return {
    ...state,
    updatedAt: now,
    files: {
      ...state.files,
      [key]: {
        ...previous,
        reviewedAt: undefined,
        reviewDiffIdentity: undefined
      }
    }
  }
}

export function completeMobileDiffReviewState(
  state: MobileDiffReviewState,
  now: number
): MobileDiffReviewState {
  return { ...state, updatedAt: now, completedAt: now }
}

export function isMobileDiffReviewFileReviewed(
  fileState: MobileDiffReviewFileState | undefined,
  diffIdentity: string
): boolean {
  return fileState?.reviewedAt !== undefined && fileState.reviewDiffIdentity === diffIdentity
}

export function didMobileDiffReviewFileChangeSinceReview(
  fileState: MobileDiffReviewFileState | undefined,
  diffIdentity: string
): boolean {
  return (
    fileState?.reviewedAt !== undefined &&
    fileState.reviewDiffIdentity !== undefined &&
    fileState.reviewDiffIdentity !== diffIdentity
  )
}

export function buildMobileDiffIdentity(parts: readonly string[]): string {
  let hash = 2166136261
  for (const part of parts) {
    hash = Math.imul(hash ^ part.length, 16777619)
    for (let index = 0; index < part.length; index += 1) {
      hash = Math.imul(hash ^ part.charCodeAt(index), 16777619)
    }
  }
  return `d${(hash >>> 0).toString(36)}`
}
