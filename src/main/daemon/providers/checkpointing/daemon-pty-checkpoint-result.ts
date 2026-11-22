import type { HistoryCheckpointResult } from '../../history/storage/terminal-history-manager-options'

/** What one checkpoint write proved: committed, deferred for retry, or unavailable (not written). */
export type CheckpointWriteResult = 'done' | 'deferred' | 'unavailable'

/**
 * Persistence must not collapse `unavailable` into `done` (#46691): "could not write" is not
 * "wrote". Sleep kills a terminal only after a committed final checkpoint, so a lost writer or
 * a rejected publication has to stay distinguishable from a commit all the way up.
 */
export function mapHistoryCheckpointResult(
  result: HistoryCheckpointResult
): CheckpointWriteResult {
  switch (result) {
    case 'committed':
      return 'done'
    case 'retryable':
      return 'deferred'
    case 'unavailable':
      return 'unavailable'
  }
}
