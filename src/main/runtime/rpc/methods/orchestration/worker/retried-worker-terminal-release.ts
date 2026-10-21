import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { isStructuredWorkerHandle } from '../../../../../../shared/structured-worker-handle'
import { completeWorkerTerminalRelease } from './worker-release-completion'

/**
 * A `--retry-of` start replaces a failed attempt, so the terminal that attempt still owns goes
 * through the same release as `worker-release`: output archived, a user takeover kept, and a
 * release cut short by a restart finished by recovery. Without it every retry of a failed start
 * left one more live agent behind.
 *
 * Cleanup only: the retry neither waits on it nor fails because of it.
 */
export function releaseRetriedWorkerTerminal(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  start: { retryOf?: string; terminal?: string }
): void {
  const { retryOf } = start
  // An explicit `--terminal` may be the failed attempt's own pane, now taken by the retry.
  if (!retryOf || start.terminal) {
    return
  }
  try {
    const owned = db.getWorkerTerminalResourceByOwner(retryOf)
    if (
      db.getWorkerDispatch(retryOf)?.state !== 'failed' ||
      owned?.ownership_state !== 'owned' ||
      owned.release_state !== 'not_requested' ||
      isStructuredWorkerHandle(owned.terminal_handle)
    ) {
      return
    }
    const requested = db.requestWorkerTerminalRelease(retryOf)
    if (requested.disposition !== 'requested') {
      return
    }
    void completeWorkerTerminalRelease({
      runtime,
      db,
      dispatchId: retryOf,
      resource: requested.resource
    }).then(
      (receipt) => {
        // Nobody reads this receipt, so an unproven close must at least leave a trace.
        if (receipt.state !== 'released' && receipt.state !== 'already_released') {
          console.warn('[orchestration] retried worker terminal not released', retryOf, receipt)
        }
      },
      (error: unknown) => {
        console.warn('[orchestration] retried worker terminal release failed', retryOf, error)
      }
    )
  } catch (error) {
    console.warn('[orchestration] retried worker terminal release failed', retryOf, error)
  }
}
