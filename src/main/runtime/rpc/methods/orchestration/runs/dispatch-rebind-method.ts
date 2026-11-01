import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isEquivalentPaneKey } from '../../../../orchestration/db/pane-key-match'
import { DispatchRebindParams } from '../../../../../../shared/rpc-contract/orchestration-dispatch-rebind-params'

/**
 * Move an active Dispatch to another live terminal (issue #36765): a worker whose context grows
 * hands off to a fresh agent session in a new terminal of the same worktree, and the Dispatch
 * authority follows instead of staying bound to the old terminal handle.
 *
 * Authority to rebind comes from the caller's attested terminal identity — the current assignee
 * performing the handoff, or the Run coordinator's terminal — never from payload knowledge.
 */
export const ORCHESTRATION_DISPATCH_REBIND_METHODS = [
  defineMethod({
    name: 'orchestration.dispatchRebind',
    permission: 'workspace',
    params: DispatchRebindParams,
    handler: (params, { runtime, orchestrationCompatibilityEvidence }) => {
      // An authority move must be affirmed by terminal attestation (launch token + host + hook);
      // a claimed --from handle alone proves nothing.
      const caller = runtime.verifyOrchestrationCompatibilityCaller(
        orchestrationCompatibilityEvidence
      )
      if (!caller) {
        throw new OrchestrationError(
          'no_active_sender_terminal',
          'Rebinding a Dispatch requires running this command inside a live Orca terminal whose ' +
            'identity can be attested. The current worker terminal performs the handoff, or the ' +
            'Run coordinator terminal moves the Dispatch on the worker’s behalf.'
        )
      }
      const db = runtime.getOrchestrationDb()
      const dispatch = db.getDispatchContextById(params.dispatch)
      if (!dispatch) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Dispatch ${params.dispatch} was not found.`
        )
      }
      if (db.getFederatedDispatch(params.dispatch)) {
        throw new OrchestrationError(
          'invalid_argument',
          `Dispatch ${params.dispatch} is supervised by a connected server; rebind it there. No effects were applied.`
        )
      }
      if (dispatch.assignee_orca_session_id) {
        throw new OrchestrationError(
          'invalid_argument',
          `Dispatch ${params.dispatch} is held by an agent session, not a terminal, and keeps its session identity. No effects were applied.`
        )
      }
      const isAssignee =
        (dispatch.assignee_pane_key !== null &&
          caller.paneKey !== null &&
          isEquivalentPaneKey(dispatch.assignee_pane_key, caller.paneKey)) ||
        (dispatch.assignee_handle !== null && dispatch.assignee_handle === caller.terminalHandle)
      const isRunCoordinator =
        caller.paneKey !== null && db.getCurrentRunForPane(caller.paneKey)?.id === dispatch.run_id
      if (!isAssignee && !isRunCoordinator) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Only the Dispatch's current worker terminal or its Run coordinator can rebind ` +
            `${params.dispatch}; terminal ${caller.terminalHandle} is neither. No effects were applied.`
        )
      }
      const targetAuthority = runtime.getOrchestrationDispatchAuthority(params.to)
      const targetPaneKey = targetAuthority?.paneKey ?? runtime.getTerminalPaneKey(params.to)
      if (!targetPaneKey || !targetAuthority?.processIncarnation) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${params.to} has no stable pane/process incarnation for lifecycle authority.`
        )
      }
      const dispatchRebound = db.rebindDispatchAssignee({
        dispatchId: params.dispatch,
        handle: params.to,
        paneKey: targetPaneKey,
        processIncarnation: targetAuthority.processIncarnation,
        hostScope: targetAuthority.hostScope ? JSON.stringify(targetAuthority.hostScope) : null
      })
      return { dispatch: dispatchRebound, reboundBy: caller.terminalHandle }
    }
  })
]
