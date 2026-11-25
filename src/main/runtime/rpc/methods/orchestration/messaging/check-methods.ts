import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { CheckParams } from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { parseMessageTypes } from '../routing'
import { checkRunMailbox } from './check-run'
import { checkWorkerMailbox } from './check-worker'
import { checkDirectMailbox } from './check-direct'
import { withOwnDirectMail } from './check-own-direct-mail'
import { CheckMailReconciliation } from './check-mail-reconciliation'
import { callerMailTaker } from '../../../../orchestration/db/messages/mail-taker'
import {
  checkedMailboxes,
  handsOverBatch,
  withReplyFollowUps,
  withReportItems
} from './mailbox-message-receipt'
import { withRunCheckNext } from '../receipt-next'
import {
  ORCHESTRATION_UNBOUND_RUN_ID,
  orchestrationSkillRecoveryData
} from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import {
  hasRunBindingKey,
  sessionCallerOf
} from '../../../../orchestration/addressing/orchestration-caller-identity'
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
      const reader = sessionCallerOf(orchestrationCaller)
      // Mail this check takes may still wait as a card in a chat's queue; that card must not run too.
      // The item line is read for this answer only; the check's recorded receipt never holds it.
      const releasing = <T>(result: T): Promise<T> => {
        if (consumingCheck && params.ack && !params.wait) {
          runtime.withdrawStaleChatMail(checkedMailboxes(result))
        }
        return withReportItems(
          runtime,
          db,
          consumingCheck && !(params.ack && !params.wait)
            ? result
            : withReplyFollowUps(runtime, db, reader, result)
        )
      }
      // A known worker's stale handle that exact recovery refused must not fall back to a by-handle or
      // pane lookup, Run binding included: that could read its replaced Dispatch's mail, or a successor's
      // instructions and Run mail in the same pane.
      if (reporter.unrecoveredStaleWorker()) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Terminal ${handle} no longer names a terminal, and its recorded worker process could not be recovered. Nothing was read.`
        )
      }
      const { recovered } = reporter
      // A recovered caller stays the exact Dispatch and process it was recovered as, at entry and after waits.
      const recoveredLocalProcessCurrent = recovered
        ? () =>
            db.isDispatchProcessCurrent({
              dispatchId: recovered.dispatchId,
              paneKey: recovered.paneKey,
              processIncarnation: reporter.processIncarnation()
            })
        : undefined
      const livePane = runtime.getTerminalPaneKey(handle)
      const process = runtime.getTerminalProcessIncarnation(handle)
      const revalidateCaller = () => {
        if (
          runtime.getTerminalPaneKey(handle) !== livePane ||
          runtime.getTerminalProcessIncarnation(handle) !== process
        ) {
          throw new OrchestrationError(
            'consumer_fenced',
            'This mailbox caller was replaced while checking mail.'
          )
        }
      }
      // run_unbound is the id the caller's own direct mail (bot item mail) carries, not a Run.
      const unboundOnly = params.run === ORCHESTRATION_UNBOUND_RUN_ID
      const reconciliation = new CheckMailReconciliation(
        runtime,
        db,
        callerMailTaker(caller),
        signal
      )
      try {
        if (!unboundOnly && (params.run || boundRun)) {
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
            recordMutationReceipt,
            reconciliation,
            reader,
            revalidateCaller
          })
          const answer =
            consumingCheck && !(params.ack && !params.wait) && !handsOverBatch(result)
              ? await withRunCheckNext(runtime, result)
              : result
          return await releasing(
            !params.run && boundRun && consumingCheck && !params.ack && !params.wait
              ? await withOwnDirectMail({
                  runtime,
                  db,
                  reader,
                  handle,
                  runId: boundRun.id,
                  typeFilter,
                  format: params.format === true || params.inject === true,
                  reconciliation,
                  revalidate: revalidateCaller,
                  record: recordMutationReceipt,
                  result: answer
                })
              : answer
          )
        }

        const activeDispatch = db.getActiveDispatchForIdentity(handle, paneKey)
        // Why: reading another pane's Dispatch mail is wrong in every mode, so peek is fenced too.
        if (activeDispatch && !callerHoldsDispatchPane(activeDispatch, paneKey)) {
          throw dispatchFenced()
        }
        if (
          activeDispatch &&
          recovered &&
          (activeDispatch.id !== recovered.dispatchId || !recoveredLocalProcessCurrent?.())
        ) {
          throw dispatchFenced()
        }
        const remoteAttachment =
          !activeDispatch && paneKey ? db.findActiveRemoteAttachmentForPane(paneKey) : undefined
        if (
          remoteAttachment &&
          ((recovered && remoteAttachment.dispatch_id !== recovered.dispatchId) ||
            !db.isRemoteAttachmentProcessCurrent({
              dispatchId: remoteAttachment.dispatch_id,
              paneKey: paneKey ?? null,
              processIncarnation: reporter.processIncarnation()
            }))
        ) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${remoteAttachment.dispatch_id} is no longer attached to this worker process.`
          )
        }
        if ((activeDispatch || remoteAttachment) && !unboundOnly) {
          return await releasing(
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
              recoveredLocalProcessCurrent,
              recordMutationReceipt,
              reconciliation,
              reader,
              revalidateCaller,
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
        return await releasing(
          await checkDirectMailbox({
            params: unboundOnly ? { ...params, run: undefined } : params,
            ...(unboundOnly ? { runId: ORCHESTRATION_UNBOUND_RUN_ID } : {}),
            runtime,
            db,
            handle,
            typeFilter,
            signal,
            reconciliation,
            reader,
            recordMutationReceipt,
            revalidateConsumer: () => {
              revalidateCaller()
              if (
                (!unboundOnly && db.getCurrentRunForCoordinator(caller)) ||
                db.getActiveDispatchForIdentity(handle, paneKey) ||
                (paneKey && db.findActiveRemoteAttachmentForPane(paneKey))
              ) {
                throw new OrchestrationError(
                  'consumer_fenced',
                  'This direct mailbox became owned by a Run or Dispatch while checking mail.'
                )
              }
            }
          })
        )
      } finally {
        reconciliation.dispose()
      }
    }
  })
]
