import type { CodexSessionCollection } from './codex-session-root-dedup'
import { sessionSortTime } from './session-scanner-accumulator'

type ScanSessions = Pick<CodexSessionCollection, 'size' | 'values'>

function sortedCutoffIsNewer(
  times: number[],
  limit: number,
  nextCandidateMtimeMs: number
): boolean {
  const visibleCutoff = times.sort((left, right) => right - left).at(limit - 1)
  return typeof visibleCutoff === 'number' && nextCandidateMtimeMs < visibleCutoff
}

export function canStopParsingSessions(
  sessions: ScanSessions,
  limit: number,
  nextCandidateMtimeMs: number | undefined
): boolean {
  if (sessions.size < limit || typeof nextCandidateMtimeMs !== 'number') {
    return false
  }
  const times = Array.from(sessions.values(), sessionSortTime)
  if (!Number.isInteger(limit) || limit <= 0) {
    return sortedCutoffIsNewer(times, limit, nextCandidateMtimeMs)
  }

  // The top-N cutoff is newer exactly when N retained sessions beat the next mtime.
  let newerCount = 0
  for (const time of times) {
    if (Number.isNaN(time)) {
      // NaN makes the old comparator inconsistent; preserve its ordering verbatim.
      return sortedCutoffIsNewer(times, limit, nextCandidateMtimeMs)
    }
    if (time > nextCandidateMtimeMs) {
      newerCount += 1
    }
  }
  // Check every timestamp before deciding: a later NaN requires the legacy sort.
  return newerCount >= limit
}
