import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsagePersistedState,
  ClaudeUsageSession
} from './types'
import { iterateClaudeUsageResumeProjection } from './transcript-resume-projection'
import { decodeClaudeUsagePersistedFile } from './persisted-token-columns'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import {
  finalizeClaudeSessions,
  mergeClaudeDailyAggregates,
  mergeClaudeSessions
} from './usage-aggregation'

export type ClaudeUsageValidatedSources = {
  processedFiles: ClaudeUsagePersistedFile[]
  resumable: Set<ClaudeUsagePersistedFile>
  invalidated: boolean
}
export type ClaudeUsageVerifiedSources = Pick<WeakSet<ClaudeUsagePersistedFile>, 'has'>

function invalidateSavedProjections(
  state: ClaudeUsagePersistedState,
  processedFiles: ClaudeUsagePersistedState['processedFiles']
): ClaudeUsagePersistedState {
  return {
    ...state,
    processedFiles,
    sessions: [],
    dailyAggregates: [],
    scanState: {
      ...state.scanState,
      lastScanCompletedAt: null,
      lastScanError: 'Saved usage totals could not be validated. Refresh to rebuild them.'
    }
  }
}

export function hasClaudeUsageProtectedCheckpoint(file: ClaudeUsagePersistedFile): boolean {
  if (!file) {
    return true
  }
  const checkpoint = file.parseResumeState
  if (checkpoint === undefined || checkpoint === null) {
    return false
  }
  return (
    typeof checkpoint !== 'object' ||
    Array.isArray(checkpoint) ||
    checkpoint.projectionIntegrity !== undefined ||
    'tokenCodecVersion' in checkpoint ||
    'ownedTokenColumns' in checkpoint
  )
}

function requiresValidation(state: ClaudeUsagePersistedState): boolean {
  try {
    return state.processedFiles.some(hasClaudeUsageProtectedCheckpoint)
  } catch {
    return true
  }
}

export function* iterateClaudeUsageSourceValidation(
  files: ClaudeUsagePersistedFile[],
  verifiedSources?: ClaudeUsageVerifiedSources
): Generator<void, ClaudeUsageValidatedSources> {
  const processedFiles: ClaudeUsagePersistedFile[] = []
  const resumable = new Set<ClaudeUsagePersistedFile>()
  let invalidated = false
  for (let index = 0; index < files.length; index++) {
    let file = files[index]
    try {
      if (
        !file ||
        typeof file.path !== 'string' ||
        !Array.isArray(file.sessions) ||
        !Array.isArray(file.dailyAggregates) ||
        !Array.isArray(file.ownedDedupeKeys) ||
        typeof file.hasDeferredClaims !== 'boolean'
      ) {
        throw new Error('Saved Claude usage source projection is invalid.')
      }
      const checkpoint = file.parseResumeState
      const verified = verifiedSources?.has(file) ?? false
      const packed = Boolean(
        checkpoint && ('tokenCodecVersion' in checkpoint || 'ownedTokenColumns' in checkpoint)
      )
      file = yield* decodeClaudeUsagePersistedFile(file)
      if (verified && files[index] !== file) {
        // Verified inputs are the worker's private parsed array; release packed columns as decoded.
        files[index] = file
      }
      if (
        (packed || file.parseResumeState?.projectionIntegrity !== undefined) &&
        !verified &&
        !(yield* iterateClaudeUsageResumeProjection(file))
      ) {
        throw new Error('Saved Claude usage source integrity is invalid.')
      }
      processedFiles.push(file)
      if (typeof file.parseResumeState?.projectionIntegrity === 'string') {
        resumable.add(file)
      }
    } catch {
      invalidated = true
    }
    if ((index + 1) % 4 === 0) {
      yield
    }
  }
  // Lost owners require deferred forks to reclaim their copied records on the next scan.
  return {
    processedFiles: invalidated
      ? processedFiles.filter((file) => !file.hasDeferredClaims)
      : processedFiles,
    resumable,
    invalidated
  }
}

export function normalizeClaudeUsageSourceFiles(
  files: ClaudeUsagePersistedFile[],
  verifiedSources?: ClaudeUsageVerifiedSources
): ClaudeUsageValidatedSources {
  const iterator = iterateClaudeUsageSourceValidation(files, verifiedSources)
  while (true) {
    const next = iterator.next()
    if (next.done) {
      return next.value
    }
  }
}

function* validateSavedProjections(
  state: ClaudeUsagePersistedState
): Generator<void, ClaudeUsagePersistedState> {
  if (!requiresValidation(state)) {
    return state
  }
  const { processedFiles, invalidated } = yield* iterateClaudeUsageSourceValidation(
    state.processedFiles
  )
  if (invalidated) {
    return invalidateSavedProjections(state, processedFiles)
  }
  const sessions = new Map<string, ClaudeUsageSession>()
  const daily = new Map<string, ClaudeUsageDailyAggregate>()
  for (const [index, file] of processedFiles.entries()) {
    mergeClaudeSessions(sessions, file.sessions)
    mergeClaudeDailyAggregates(daily, file.dailyAggregates)
    if ((index + 1) % 4 === 0) {
      yield
    }
  }
  return {
    ...state,
    processedFiles,
    sessions: finalizeClaudeSessions(sessions),
    dailyAggregates: [...daily.values()].sort((a, b) =>
      a.day === b.day ? a.projectLabel.localeCompare(b.projectLabel) : a.day.localeCompare(b.day)
    ),
    scanState: state.scanState
  }
}

export function validatePersistedClaudeUsageProjections(
  state: ClaudeUsagePersistedState
): ClaudeUsagePersistedState {
  try {
    const iterator = validateSavedProjections(state)
    while (true) {
      const next = iterator.next()
      if (next.done) {
        return next.value
      }
    }
  } catch {
    // Malformed cache records must not reset the user's tracking preference.
    return invalidateSavedProjections(state, [])
  }
}

async function initializeSavedProjections(
  state: ClaudeUsagePersistedState
): Promise<ClaudeUsagePersistedState> {
  await yieldToEventLoop()
  try {
    const iterator = validateSavedProjections(state)
    while (true) {
      const next = iterator.next()
      if (next.done) {
        return next.value
      }
      await yieldToEventLoop()
    }
  } catch {
    return invalidateSavedProjections(state, [])
  }
}

export function initializePersistedClaudeUsageProjections(
  state: ClaudeUsagePersistedState
): ClaudeUsagePersistedState | Promise<ClaudeUsagePersistedState> {
  return requiresValidation(state) ? initializeSavedProjections(state) : state
}
