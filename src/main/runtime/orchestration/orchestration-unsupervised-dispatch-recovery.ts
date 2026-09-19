import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import { inspectWorkerTerminal } from '../rpc/methods/orchestration/worker/worker-observation'

/**
 * Residual M: a Dispatch created context-only (e.g. `orchestration dispatch --inject`) has no
 * worker_dispatches row, so it never entered `planLegacyWorkerTerminalRecovery`'s candidates —
 * that pipeline re-adopts a PTY Orca itself spawned, which an injected terminal never was. This
 * settles the narrower question those Dispatches actually need answered: is the assignee
 * terminal this Dispatch names still the exact one it was sent to?
 *
 * Reuses `inspectWorkerTerminal`, the same liveness primitive `worker-show` uses for
 * context-only workers, so "re-adoptable" and "gone" agree with what an operator already sees.
 */
export async function reconcileUnsupervisedDispatchesOnRestart(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb
): Promise<{ failedDispatchIds: string[] }> {
  const failedDispatchIds: string[] = []
  for (const dispatch of db.listUnsupervisedActiveDispatches()) {
    const observation = await inspectWorkerTerminal(runtime, db, dispatch.id)
    // Why these three and not 'unverifiable': loss of contact is never proof of death (SSH
    // boundary), so only a terminal Orca can positively no longer find, or one now occupied by
    // a different process, counts as gone. 'live' and 'unverifiable' are left untouched.
    const gone =
      observation.status === 'missing' ||
      observation.status === 'identity_changed' ||
      observation.status === 'exited'
    if (!gone) {
      continue
    }
    db.reconcileMissingWorkerTerminal(
      dispatch.id,
      'Unsupervised dispatch terminal is no longer live after orchestration recovery.'
    )
    failedDispatchIds.push(dispatch.id)
  }
  return { failedDispatchIds }
}
