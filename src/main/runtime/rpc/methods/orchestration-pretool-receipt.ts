import { z } from 'zod'
import { ControlPlaneStore } from '../../orchestration/control-plane/control-plane-store'
import { recordPretoolReceipt } from '../../orchestration/control-plane/pretool-receipt'
import { readDispatchLaunchRoutes } from '../../orchestration/control-plane/route-runtime-events'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { resolveWorkerMutationVerdict } from '../../orchestration/control-plane/worker-mutation-verdict'
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
        buildId: runtime.getBuildIdentity().id
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

/** The question the PreTool policy cannot answer for itself.
 *
 *  Orca decides no policy here and adds no allowlist. It reports one fact it
 *  alone owns — whether the workspace this attested session occupies is under
 *  someone else's validation lease right now — so the single existing policy can
 *  deny a tool call that would edit a tree a gate is running on.
 *
 *  This is the path the dispatcher fence cannot reach. A worker that is already
 *  running does not mutate through `files.write` or `terminal.send`; it uses its
 *  own Bash and Edit inside a shell that predates the lease, which is exactly
 *  how two certification workers committed to the Package B branch mid-gate.
 *
 *  Read-only by construction: it writes nothing, so asking can never manufacture
 *  the acceptance receipt that `pretool_acceptance` requires.
 */
export const MUTATION_VERDICT_METHOD: RpcMethod = defineMethod({
  name: 'orchestration.mutationVerdict',
  params: z.object({ tool: OptionalString, from: OptionalString }),
  handler: (_params, { runtime, orchestrationCompatibilityEvidence }) => {
    const evidence = orchestrationCompatibilityEvidence
    // Attested identity only, and ONE placement record for it. A pane key a
    // caller could state is a pane key it could borrow; resolving the terminal,
    // the workspace and the exact provider session together from the runtime's
    // own record is what makes the answer about this session rather than about
    // whoever occupied this pane last.
    const paneKey = evidence?.paneKey
    const placement = paneKey ? runtime.resolveAttestedPanePlacement(paneKey) : null
    return {
      verdict: resolveWorkerMutationVerdict({
        db: runtime.getOrchestrationDb(),
        session: {
          terminalHandle: placement?.terminalHandle ?? evidence?.terminalHandle,
          paneKey,
          processIncarnation: placement?.processIncarnation,
          worktreeId: placement?.worktreeId
        },
        nowMs: Date.now()
      })
    }
  }
})
