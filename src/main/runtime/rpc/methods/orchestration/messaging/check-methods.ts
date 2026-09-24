import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { CheckParams } from '../schemas'
import { parseMessageTypes } from '../routing'
import { checkRunMailbox } from './check-run'
import { checkWorkerMailbox } from './check-worker'
import { checkDirectMailbox } from './check-direct'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration-rpc-contract'
import { hasRunBindingKey } from '../../../../orchestration/orchestration-caller-identity'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import {
  callerHoldsDispatchPane,
  dispatchFenced,
  isSupersededDispatch
} from './dispatch-mailbox-fence'

export const ORCHESTRATION_CHECK_METHODS = [
  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        orchestrationCaller,
        runtime,
        signal,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        recordMutationReceipt
      }
    ) => {
      if (params.wait === true && orchestrationCaller?.runtimeKind === 'native') {
        throw waitRequiresTerminal(orchestrationCaller.sessionId)
      }
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = parseMessageTypes(params.types)

      const caller = orchestrationCallerIdentity(runtime, {
        handle,
        session: orchestrationCaller,
        // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
        paneKey: runtime.getTerminalPaneKey(handle) ?? params.terminalPaneKey
      })
      const paneKey = caller.paneKey ?? undefined
      const boundRun = hasRunBindingKey(caller) ? db.getCurrentRunForCoordinator(caller) : undefined
      if (params.run || boundRun) {
        return checkRunMailbox({
          params,
          runtime,
          db,
          handle,
          paneKey,
          callerSession: orchestrationCaller,
          typeFilter,
          signal,
          legacyCoordinatorRunId,
          revalidateLegacyCoordinator,
          orchestrationCompatibilityEvidence,
          recordMutationReceipt
        })
      }

      const activeDispatch = db.getActiveDispatchForIdentity(handle, paneKey)
      // Why: reading another pane's Dispatch mail is wrong in every mode, so peek is fenced too.
      if (activeDispatch && !callerHoldsDispatchPane(activeDispatch, paneKey)) {
        throw dispatchFenced()
      }
      const remoteAttachment =
        !activeDispatch && paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
      if (
        remoteAttachment &&
        !db.isRemoteAttachmentProcessCurrent({
          dispatchId: remoteAttachment.dispatch_id,
          paneKey: paneKey ?? null,
          processIncarnation: runtime.getTerminalProcessIncarnation(handle)
        })
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${remoteAttachment.dispatch_id} is no longer attached to this worker process.`
        )
      }
      if (activeDispatch || remoteAttachment) {
        return checkWorkerMailbox({
          params,
          runtime,
          db,
          handle,
          paneKey,
          typeFilter,
          signal,
          activeDispatch,
          remoteAttachment
        })
      }
      const consumingCheck = params.peek !== true && params.all !== true && params.unread !== false
      // Why: an empty consuming check is the worker contract's "checkpoint, not a failure", so a
      // caller whose Attempt moved on has to be told rather than handed an empty direct mailbox.
      // This outranks the pane guard: a paneless loser cannot run-use anyway, it has to stop.
      const settledDispatch = consumingCheck ? db.getLatestDispatchForTerminal(handle) : undefined
      if (settledDispatch && isSupersededDispatch(settledDispatch)) {
        throw dispatchFenced()
      }
      // Why: a consuming check on a handle with no live pane and no Dispatch can never see
      // Run mail, so an empty inbox would read as "nothing yet" instead of a stale caller.
      if (!hasRunBindingKey(caller) && consumingCheck) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${handle} has no live pane bound to a Run, so this inbox can never receive Run mail. Rebind this terminal with orchestration run-use, or read the Run mailbox with --run <run_id>.`,
          orchestrationSkillRecoveryData()
        )
      }
      return checkDirectMailbox({ params, runtime, db, handle, typeFilter, signal })
    }
  })
]

/**
 * A native chat runs turn by turn through a shell tool with its own timeout, so a blocking wait is
 * killed mid-wait and retried. Keyed on the lease: a session a terminal view holds may block.
 */
function waitRequiresTerminal(sessionId: string): OrchestrationError {
  return new OrchestrationError(
    'wait_requires_terminal',
    `Agent session ${sessionId} is a chat, which runs turn by turn, so check --wait would outlive your shell tool. Run check without --wait, process and --ack what it returns, then end your turn: Orca starts a new turn in this chat when mail arrives. No effects were applied.`,
    { effectsApplied: false }
  )
}
