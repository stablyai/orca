import { isSqliteCorruption, isTransientSqliteContention } from '../sqlite-read-failure'
import { isUnusableDatabaseError } from '../versioned-cache-database'

/** busy: another connection holds the lock, retry later. corrupt: rebuild. other: report. */
export type RowCacheFailure = 'busy' | 'corrupt' | 'other'

export function classifyRowCacheFailure(error: unknown): RowCacheFailure {
  if (isTransientSqliteContention(error)) {
    return 'busy'
  }
  return isSqliteCorruption(error) || isUnusableDatabaseError(error) ? 'corrupt' : 'other'
}

export type RetryBackoff = { readonly minMs: number; readonly maxMs: number }

/** Doubling delay after `previousMs` (0 for the first failure), clamped to the range. */
export function nextRetryDelayMs(previousMs: number, { minMs, maxMs }: RetryBackoff): number {
  return Math.min(maxMs, Math.max(minMs, previousMs * 2))
}
