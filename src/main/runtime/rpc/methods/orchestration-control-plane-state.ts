import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { describeOutcomeState } from '../../orchestration/control-plane/outcome-state-recovery'
import { RouteRegistryStore } from '../../orchestration/control-plane/route-registry-store'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString } from '../schemas'

const ControlPlaneStateParams = z.object({
  outcome: OptionalString,
  run: OptionalString,
  task: OptionalString,
  dispatch: OptionalString
})

/** B10 — the single bounded recovery query. Read-only: it never mutates
 *  lifecycle state, so a recovering caller can always run it safely. */
export const ORCHESTRATION_CONTROL_PLANE_STATE_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.state',
    params: ControlPlaneStateParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.outcome && !params.run && !params.task && !params.dispatch) {
        throw new OrchestrationError(
          'invalid_argument',
          'Select at least one target: outcome, run, task, or dispatch.'
        )
      }
      const store = new ControlPlaneStore(db)
      const registryStore = new RouteRegistryStore(db)
      const dispatch = params.dispatch ? db.getDispatchContextById(params.dispatch) : undefined
      const task = params.task
        ? db.getTask(params.task)
        : dispatch
          ? db.getTask(dispatch.task_id)
          : undefined
      const outcome = params.outcome ? store.getOutcomeById(params.outcome) : undefined
      // Why the outcome's own Run: an outcome-only query must still resolve the
      // mailbox, otherwise recovery reports "no events" for a busy Run.
      const runId = params.run ?? task?.run_id ?? dispatch?.run_id ?? outcome?.run_id
      // Why bounded: the newest page of the Run mailbox, not the whole history.
      // The report only needs the newest wake-worthy row.
      const recentMessages = runId ? db.getRunMailboxHistory(runId, 25) : []
      return describeOutcomeState(
        {
          outcomeId: params.outcome,
          runId,
          taskId: task?.id ?? params.task,
          dispatchId: dispatch?.id ?? params.dispatch
        },
        {
          store,
          outcome,
          task: task ?? undefined,
          dispatch: dispatch ?? undefined,
          // Why reversed: getRunMailboxHistory returns newest-first, and the
          // picker scans from the end.
          recentMessages: recentMessages.toReversed(),
          routeEvidence: registryStore.listRouteEvidence(),
          nowMs: Date.now()
        }
      )
    }
  })
]
