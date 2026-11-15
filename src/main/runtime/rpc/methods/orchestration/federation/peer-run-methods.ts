import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { WORKER_SETTLED_STATES } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import {
  PeerRunCancelParams,
  type PeerRunCancelResult
} from '../../../../../../shared/orchestration/remote-owned-wire'
import type { z } from 'zod'
import { stopWorkerAndHelpers } from '../worker/worker-stop'

export const ORCHESTRATION_PEER_RUN_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.peerRunCancel',
    access: { kind: 'writes', targets: {} },
    permission: 'workspace',
    params: PeerRunCancelParams,
    /** The paired Orca reset its Run: close it here, then run the ordinary stop on each live worker. */
    handler: async (_params, { runtime, orchestrationCaller }) => {
      if (orchestrationCaller?.kind !== 'peer') {
        throw new OrchestrationError(
          'forbidden',
          'Only the paired Orca that coordinates a Run cancels it. No effects were applied.',
          { effectsApplied: false }
        )
      }
      const db = runtime.getOrchestrationDb()
      const runId = orchestrationCaller.peerRun.run_id
      // Committed before any stop, so nothing more starts in it while the stops run.
      db.closePeerRun(runId)
      for (const dispatchId of liveWorkerDispatchIds(db, runId)) {
        // Each stop's own outcome stays on its Dispatch; the count below is the answer.
        await stopWorkerAndHelpers(runtime, dispatchId, undefined).catch(() => undefined)
      }
      const result: z.infer<typeof PeerRunCancelResult> = {
        remaining: liveWorkerDispatchIds(db, runId).length
      }
      return result
    }
  })
]

/** Workers in the Run not yet proven settled; a Run this Orca never had work in has none. */
function liveWorkerDispatchIds(db: OrchestrationDb, runId: string): string[] {
  const settled = WORKER_SETTLED_STATES.map(() => '?').join(', ')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SELECT of one column returns exactly that column.
  const rows = db.db
    .prepare(
      `SELECT d.id FROM dispatch_contexts d JOIN worker_dispatches w ON w.dispatch_id = d.id
       WHERE d.run_id = ? AND w.state NOT IN (${settled}) ORDER BY d.rowid`
    )
    .all(runId, ...WORKER_SETTLED_STATES) as { id: string }[]
  return rows.map((row) => row.id)
}
