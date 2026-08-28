import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { recordPretoolReceipt } from '../../orchestration/control-plane/pretool-receipt'
import { readDispatchLaunchRoutes } from '../../orchestration/control-plane/route-runtime-events'
import { resolveRuntimeBuildIdentity } from '../../orchestration/control-plane/runtime-build-identity'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

/** Orca does not decide whether a tool may run — the existing PreTool policy
 *  does. This records what that decision WAS, so certification can see it,
 *  without a second security boundary that could drift from the first. */
export const PRETOOL_RECEIPT_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.pretoolReceipt',
  params: z.object({
    decision: z.enum(['allow', 'block']),
    policy: requiredString('--policy'),
    policyVersion: requiredString('--policy-version'),
    tool: OptionalString,
    reason: OptionalString,
    from: OptionalString
  }),
  handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
    const db = runtime.getOrchestrationDb()
    // The emitter states only what the decision owns. Everything that binds
    // the receipt to work — Dispatch, Run, outcome, Task, pane, incarnation,
    // route, build — comes from the runtime's own records, keyed by the
    // ATTESTED caller. An emitter cannot name a Dispatch, so it cannot aim a
    // receipt at one it does not occupy.
    const evidence = orchestrationCompatibilityEvidence
    const paneKey = evidence?.paneKey
    const terminalHandle = evidence?.terminalHandle
    if (!paneKey || !terminalHandle) {
      throw new OrchestrationError(
        'pretool_receipt_unattested',
        'A PreTool receipt must come from an attested Orca session; nothing binds an unattested one to a Dispatch.'
      )
    }
    const dispatch = db.getActiveDispatchForIdentity(terminalHandle, paneKey)
    if (!dispatch) {
      throw new OrchestrationError(
        'pretool_receipt_unbound',
        `No active Dispatch occupies pane ${paneKey}, so this decision describes no supervised work.`
      )
    }
    const worker = db.getWorkerDispatch(dispatch.id)
    const outcome = new ControlPlaneStore(db).getOutcomeByRun(dispatch.run_id)
    const launch = readDispatchLaunchRoutes(worker?.start_options)
    const receipt = recordPretoolReceipt(db, {
      binding: {
        dispatchId: dispatch.id,
        runId: dispatch.run_id,
        outcomeId: outcome?.outcome_id ?? null,
        taskId: dispatch.task_id,
        terminalHandle: dispatch.assignee_handle,
        paneKey: dispatch.assignee_pane_key,
        processIncarnation: dispatch.process_incarnation,
        requestedRoute: launch.requested,
        effectiveRoute: launch.effective,
        buildId: resolveRuntimeBuildIdentity().id
      },
      claim: {
        decision: params.decision,
        policyId: params.policy,
        policyVersion: params.policyVersion,
        toolName: params.tool ?? null,
        reason: params.reason ?? null
      },
      observedAt: new Date().toISOString()
    })
    return { receipt }
  }
})
