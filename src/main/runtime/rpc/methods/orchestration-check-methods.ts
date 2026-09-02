import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { CheckParams } from './orchestration-schemas'
import { parseMessageTypes } from './orchestration-routing'
import { checkRunMailbox } from './orchestration-check-run'
import { checkWorkerMailbox } from './orchestration-check-worker'
import { checkDirectMailbox } from './orchestration-check-direct'

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
      return checkDirectMailbox({ params, runtime, db, handle, typeFilter, signal })
    }
  })
]
