import type { OrchestrationDb } from '../../../../../orchestration/db/orchestration-db'
import type { WorkerTerminalResourceRow } from '../../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { WorkerTerminalReleaseRuntime } from '../../../../../orchestration/terminal-authority/release/worker-terminal-release-runtime'
import { exposeWorkerTerminalResource } from '../release/worker-terminal-resource-presentation'
import { projectFleetWorkerPage } from './worker-observation'

/** worker-show's fleet verdict and terminal; a handed-on Dispatch shows the shared row it last held, owned by its follow-up. */
export function projectWorkerShowCustody(
  runtime: WorkerTerminalReleaseRuntime,
  db: OrchestrationDb,
  dispatchId: string,
  owned: WorkerTerminalResourceRow | undefined
) {
  const fleet = projectFleetWorkerPage(runtime, db, dispatchId)
  const handedOn = fleet?.durable.get(dispatchId)?.handedOn ?? null
  const shown = owned ?? (handedOn ? db.getWorkerTerminalResourceFormerlyOwnedBy(dispatchId) : null)
  return {
    // Why: the fleet verdict, so worker-show and worker-list cannot disagree.
    projection: fleet?.workers[0] ?? null,
    handedOnTo: handedOn?.toDispatchId ?? null,
    terminalResource: shown ? exposeWorkerTerminalResource(shown) : null
  }
}
