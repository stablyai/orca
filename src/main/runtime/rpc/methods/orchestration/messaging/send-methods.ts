import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isGroupAddress } from '../../../../orchestration/addressing/groups/group-addressing'
import {
  dispatchReportMailbox,
  isDispatchReportType
} from '../../../../orchestration/workers/reports/dispatch-report-mailbox'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import { SendParams } from './send-params'
import { isDispatchMutationMessageType } from '../../../../../../shared/rpc-contract/orchestration-params'
import { isWorkerReportOutcome, parseRemoteWorkerPayload } from './message-payload'
import { resolveMessageRun } from '../routing'
import {
  assertDispatchMailboxDeliverable,
  resolveBareOrchestrationRecipient,
  resolveRunBoundDispatchRecipient,
  type SendRecipientWarning
} from './recipient-routing'
import { replayAcceptedSend } from './send-replay'
import { sendRemoteMessage } from '../../../../orchestration/legacy-remote/send-remote'
import { withPeerMailSend } from './peer-mail-send'
import { prepareSessionRecipient } from './session-recipient'
import { sendPointToPointMessage } from './send-point-to-point'
import { sendGroupMessage } from './send-group'
import { sendFederatedControlMail } from '../../../../orchestration/legacy-remote-home/send-control-mail'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'
import { planWorkerFollowUp, startWorkerFollowUp } from './worker-follow-up'
import { finishedWorkerSend, refuseFinishedRemoteWorker } from './finished-worker-mail'
import { relayedDeliveryUnknownWarning, withDeliveryHoldWarning } from './send-delivery-hold'
import {
  followThroughWorkerReport,
  passHeldWorkerMail,
  settledDispatchId
} from './settled-worker-follow-through'

export const ORCHESTRATION_SEND_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.send',
    access: {
      kind: 'writes',
      caller: 'from',
      callerPane: 'senderPaneKey',
      server: 'on',
      targets: { to: 'party', threadId: 'message', run: 'run', payload: 'dispatch' }
    },
    permission: 'workspace',
    params: SendParams,
    replay: (params, { runtime, replayedMutationReceipt }) =>
      replayAcceptedSend(runtime, params, replayedMutationReceipt),
    handler: withPeerMailSend(
      async (
        params,
        {
          runtime,
          legacyCoordinatorRunId,
          revalidateLegacyCoordinator,
          orchestrationCompatibilityCallerAuthority,
          recordMutationReceipt,
          markWorkerDoneMutationEffectFree,
          orchestrationCaller,
          orchestrationCompatibilityEvidence,
          orchestrationMutation,
          signal
        }
      ) => {
        const db = runtime.getOrchestrationDb()
        const from = params.from ?? 'unknown'
        const attestedCaller =
          orchestrationCompatibilityCallerAuthority?.terminalHandle === from
            ? orchestrationCompatibilityCallerAuthority
            : undefined
        // Why: attested hook identity survives graph remount; caller params never supply lifecycle authority.
        const sender = orchestrationCallerIdentity(runtime, {
          handle: from,
          session: orchestrationCaller,
          paneKey: attestedCaller?.paneKey ?? runtime.getTerminalPaneKey(from)
        })
        const senderPaneKey = sender.paneKey ?? undefined
        // Why: a session caller was already bound to its own identity at the dispatch entry.
        if (isDispatchMutationMessageType(params.type) && !orchestrationCaller) {
          assertLifecycleCallerIsNotAnotherParty(runtime, {
            from,
            fromPaneKey: senderPaneKey,
            evidence: orchestrationCompatibilityEvidence
          })
        }
        const processIncarnation = () =>
          attestedCaller?.processIncarnation ??
          runtime.getTerminalProcessIncarnation(from) ??
          undefined
        const remoteAttachment = senderPaneKey
          ? db.findActiveRemoteAttachmentForPane(senderPaneKey)
          : undefined
        if (remoteAttachment && senderPaneKey) {
          return sendRemoteMessage({
            params,
            runtime,
            db,
            from,
            senderPaneKey,
            remoteAttachment,
            processIncarnation: processIncarnation(),
            signal
          })
        }

        refuseFinishedRemoteWorker(db, senderPaneKey, params.to)
        const runGroup =
          params.to &&
          isGroupAddress(params.to) &&
          !params.to.toLowerCase().startsWith('@worktree:')
        // Run groups validate their own audience; message scope cannot select a parent Dispatch.
        let routing = resolveMessageRun(runtime, {
          sender,
          to: params.to,
          runId: runGroup ? undefined : params.run,
          payload: runGroup ? undefined : params.payload,
          type: params.type
        })
        const finished = runGroup
          ? undefined
          : finishedWorkerSend(db, { ...sender, processIncarnation }, routing, params)
        ;({ params, routing } = finished ?? { params, routing })
        if (
          params.type === 'worker_done' &&
          !isWorkerReportOutcome(parseRemoteWorkerPayload(params.payload).outcome)
        ) {
          throw new OrchestrationError(
            'invalid_argument',
            'worker_done requires outcome=succeeded|failed for a current Dispatch.'
          )
        }
        if (params.to?.startsWith('task:')) {
          throw new OrchestrationError(
            'invalid_argument',
            'Task recipients are intentionally unsupported; use run:<id> or dispatch:<id>.'
          )
        }

        let to = params.to
        if (
          routing.run &&
          (!to ||
            ((params.type === 'worker_done' || params.type === 'heartbeat') && routing.dispatchId))
        ) {
          const reporting =
            routing.dispatchId && isDispatchReportType(params.type)
              ? db.getDispatchContextById(routing.dispatchId)
              : undefined
          to = reporting ? dispatchReportMailbox(db, reporting) : `run:${routing.run.id}`
        }
        if (!to) {
          throw new OrchestrationError(
            'run_required',
            'No recipient or active Dispatch Run could be resolved. No effects were applied.',
            orchestrationSkillRecoveryData()
          )
        }

        const sendWarnings: SendRecipientWarning[] = []
        let messageRunId = routing.run?.id
        if (!isGroupAddress(to) && !to.startsWith('run:') && !to.startsWith('dispatch:')) {
          const terminal = await prepareSessionRecipient(runtime, to, revalidateLegacyCoordinator)
          const recipient = resolveBareOrchestrationRecipient({
            runtime,
            db,
            handle: to,
            senderRunId: routing.run?.id,
            explicitRunId: params.run,
            terminalRecipient: terminal
          })
          if (!recipient.ok) {
            throw new OrchestrationError(recipient.code, recipient.message)
          }
          // A paired Orca's former worker may since have taken up local work; it is no longer its to reach.
          if (
            orchestrationCaller?.kind === 'peer' &&
            recipient.runId !== orchestrationCaller.peerRun.run_id
          ) {
            throw new OrchestrationError(
              'forbidden',
              `${params.to} now works outside the Run ${orchestrationCaller.peerRun.home_label} coordinates here. No effects were applied.`,
              { effectsApplied: false }
            )
          }
          to = recipient.to
          messageRunId = recipient.runId
          if (recipient.warning) {
            sendWarnings.push(recipient.warning)
          }
        }
        const withSendWarnings = <T extends object>(
          receipt: T
        ): T & { warnings?: SendRecipientWarning[] } =>
          sendWarnings.length > 0 ? { ...receipt, warnings: sendWarnings } : receipt

        if (!isGroupAddress(to)) {
          let addressedDispatchId = to.startsWith('dispatch:')
            ? to.slice('dispatch:'.length)
            : undefined
          const federatedTarget =
            addressedDispatchId && to === `dispatch:${addressedDispatchId}`
              ? db.getFederatedDispatch(addressedDispatchId)
              : undefined
          // Federated targets perform their own liveness check before relaying.
          if (addressedDispatchId && !federatedTarget) {
            const plan = planWorkerFollowUp(db, addressedDispatchId, params.type ?? 'status')
            // Only a settled worker awaits; mail to a working one stays synchronous until it is inserted.
            const followUp =
              plan?.kind === 'start'
                ? await startWorkerFollowUp({
                    ctx: {
                      runtime,
                      orchestrationCompatibilityEvidence,
                      orchestrationCaller,
                      orchestrationMutation
                    },
                    db,
                    plan,
                    from,
                    message: params
                  })
                : plan
            // The mail started the worker's next turn itself, so nothing holds it; `next` stays last.
            if (followUp?.kind === 'started') {
              if (typeof followUp.receipt.dispatchId === 'string') {
                passHeldWorkerMail(runtime, db, followUp.receipt.dispatchId)
              }
              return followUp.receipt
            }
            if (followUp) {
              addressedDispatchId = followUp.dispatchId
              to = `dispatch:${addressedDispatchId}`
            }
            assertDispatchMailboxDeliverable(runtime, db, addressedDispatchId)
            const runBound = resolveRunBoundDispatchRecipient(
              runtime,
              db,
              addressedDispatchId,
              params.run
            )
            if (runBound) {
              to = runBound.to
              messageRunId = runBound.runId
              sendWarnings.push(runBound.warning)
            }
          }
          if (federatedTarget) {
            sendWarnings.push(relayedDeliveryUnknownWarning(to))
          }
          const federatedControl = sendFederatedControlMail({
            params,
            runtime,
            db,
            from,
            to,
            messageRunId,
            revalidateLegacyCoordinator,
            recordMutationReceipt,
            withSendWarnings
          })
          if (federatedControl !== undefined) {
            return federatedControl
          }
          const sent = sendPointToPointMessage({
            params,
            runtime,
            db,
            from,
            to,
            dispatchId: routing.dispatchId,
            messageRunId,
            senderPaneKey,
            legacyCoordinatorRunId,
            resolveProcessIncarnation: processIncarnation,
            revalidateLegacyCoordinator,
            recordMutationReceipt,
            markWorkerDoneMutationEffectFree,
            withSendWarnings: (sent) =>
              finished?.receipt(withSendWarnings(sent)) ?? withSendWarnings(sent)
          })
          followThroughWorkerReport(
            runtime,
            db,
            params.type === 'worker_done' ? settledDispatchId(sent) : undefined
          )
          // Read only once the mail is stored: an await before it could let the worker settle and miss it.
          return federatedTarget || params.type === 'worker_done' || params.type === 'heartbeat'
            ? sent
            : withDeliveryHoldWarning(sent, runtime, db, to)
        }
        return sendGroupMessage({
          params,
          runtime,
          db,
          from,
          groupAddress: to,
          sender,
          senderPaneKey,
          senderRunId: routing.run?.id,
          explicitRunId: params.run,
          legacyCoordinatorRunId,
          revalidateLegacyCoordinator,
          recordMutationReceipt,
          withSendWarnings
        })
      }
    )
  })
]
