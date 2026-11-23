import type { HistoryCheckpointResult } from '../../history/storage/terminal-history-manager-options'

/**
 * What one checkpoint pass proved.
 *
 * - `committed` — the durable write landed.
 * - `deferred` — retryable; the session stays dirty for a later pass.
 * - `permanently-unavailable` — no retry can fix it (disabled session, lost writer,
 *   no history manager). Sleep may proceed on the last committed checkpoint.
 * - `no-snapshot` — there was nothing to snapshot (the live screen could not be
 *   captured, or it exceeded the transport line cap). Also terminal for Sleep.
 */
export type CheckpointWriteResult =
  | 'committed'
  | 'deferred'
  | 'permanently-unavailable'
  | 'no-snapshot'

/** A settled pass; `deferred` is excluded because it stays dirty for a later retry. */
export type SettledCheckpointOutcome = Exclude<CheckpointWriteResult, 'deferred'>

/**
 * Persistence must not collapse `unavailable` into `committed` (#46691): "could not
 * write" is not "wrote". Sleep kills a terminal only after a committed final
 * checkpoint, or when the failure is one no retry can fix (#46691 rev2).
 */
export function mapHistoryCheckpointResult(result: HistoryCheckpointResult): CheckpointWriteResult {
  switch (result) {
    case 'committed':
      return 'committed'
    case 'retryable':
      return 'deferred'
    case 'unavailable':
      return 'permanently-unavailable'
  }
}
