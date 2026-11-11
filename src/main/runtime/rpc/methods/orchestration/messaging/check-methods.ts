import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { CheckParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import { parseMessageTypes } from '../routing'
import { checkRunMailbox } from './check-run'
import { checkWorkerMailbox } from './check-worker'
import { checkDirectMailbox } from './check-direct'
import { checkedMailboxes, withReportFollowUps } from './mailbox-message-receipt'
import { withRunCheckNext } from '../receipt-next'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import { hasRunBindingKey } from '../../../../orchestration/addressing/orchestration-caller-identity'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { resolveWorkerReporterIdentity } from '../../../../orchestration/workers/reports/reminted-worker-reporter'
import {
  callerHoldsDispatchPane,
  dispatchFenced,
  isSupersededDispatch
} from './dispatch-mailbox-fence'

export const ORCHESTRATION_CHECK_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.check',
    access: {
      kind: 'writes',
      caller: 'terminal',
      callerPane: 'terminalPaneKey',
      targets: { run: 'run', ack: 'message' },
      collection: true
    },
    permission: 'workspace',
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
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = parseMessageTypes(params.types)

      // A restart can reissue a surviving worker PTY's handle; the woken worker still checks with its env
      // handle. Recover it by the Dispatch's exact recorded incarnation, as its ask and reports were.
      const reporter = resolveWorkerReporterIdentity(runtime, db, {
        from: handle,
        authority: undefined,
        hasSessionCaller: Boolean(orchestrationCaller),
        evidence: orchestrationCompatibilityEvidence
      })
      const caller = orchestrationCallerIdentity(runtime, {
        handle,
        session: orchestrationCaller,
        // Why: a live runtime handle is authoritative; pane metadata is only the restart fallback.
        paneKey: reporter.paneKey ?? params.terminalPaneKey
      })
      const paneKey = caller.paneKey ?? undefined
      const boundRun = hasRunBindingKey(caller) ? db.getCurrentRunForCoordinator(caller) : undefined
      const consumingCheck = params.peek !== true && params.all !== true && params.unread !== false
      // Mail this check takes may still wait as a card in a chat's queue; that card must not run too.
      const releasing = <T>(result: T): T => {
        if (consumingCheck) {
          runtime.withdrawStaleChatMail(checkedMailboxes(result))
        }
        return withReportFollowUps(db, result)
      }
      if (params.run || boundRun) {
        const result = await checkRunMailbox({
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
        return releasing(
          consumingCheck && !(params.ack && !params.wait)
            ? await withRunCheckNext(runtime, result)
            : result
        )
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
          processIncarnation: reporter.processIncarnation()
        })
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${remoteAttachment.dispatch_id} is no longer attached to this worker process.`
        )
      }
      if (activeDispatch || remoteAttachment) {
        return releasing(
          await checkWorkerMailbox({
            params,
            runtime,
            db,
            handle,
            paneKey,
            typeFilter,
            signal,
            activeDispatch,
            remoteAttachment,
            processIncarnation: reporter.processIncarnation,
            recordMutationReceipt,
            acknowledgeOnly: !params.wait
          })
        )
      }
      // A superseded Attempt must receive a stop signal, not an empty checkpoint; this outranks pane rebind advice.
      const settledDispatch = consumingCheck ? db.getLatestDispatchForTerminal(handle) : undefined
      if (settledDispatch && isSupersededDispatch(settledDispatch)) {
        throw dispatchFenced()
      }
      // Without a live pane or Dispatch, an empty consuming inbox would disguise a stale caller as still waiting.
      if (!hasRunBindingKey(caller) && consumingCheck) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${handle} has no live pane and no active Dispatch, so a consuming check here can never receive mail. Run check from the agent's own live terminal.`,
          orchestrationSkillRecoveryData()
        )
      }
      return releasing(
        await checkDirectMailbox({ params, runtime, db, handle, typeFilter, signal })
      )
    }
  })
]
