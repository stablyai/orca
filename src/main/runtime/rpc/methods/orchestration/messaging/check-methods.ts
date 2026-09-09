import { defineMethod, type RpcMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { CheckParams } from '../schemas'
import { parseMessageTypes } from '../routing'
import { checkRunMailbox } from './check-run'
import { checkWorkerMailbox } from './check-worker'
import { checkDirectMailbox } from './check-direct'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration-rpc-contract'
import {
  callerHoldsDispatchPane,
  dispatchFenced,
  isSupersededDispatch
} from './dispatch-mailbox-fence'

export const ORCHESTRATION_CHECK_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        signal,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        recordMutationReceipt
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = parseMessageTypes(params.types)

      // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
      const paneKey = runtime.getTerminalPaneKey(handle) ?? params.terminalPaneKey
      const boundRun = paneKey ? db.getCurrentRunForPane(paneKey) : undefined
      if (params.run || boundRun) {
        return checkRunMailbox({
          params,
          runtime,
          db,
          handle,
          paneKey,
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
      if (!paneKey && consumingCheck) {
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
