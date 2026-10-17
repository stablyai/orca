import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { isGroupAddress } from '../../../../orchestration/groups'
import { orchestrationSkillRecoveryData } from '../../../../../../shared/orchestration-rpc-contract'
import {
  SendParams,
  isDispatchMutationMessageType,
  isWorkerReportOutcome,
  parseRemoteWorkerPayload
} from '../schemas'
import { resolveMessageRun } from '../routing'
import {
  assertDispatchMailboxDeliverable,
  resolveBareOrchestrationRecipient,
  resolveRunBoundDispatchRecipient,
  type SendRecipientWarning
} from './recipient-routing'
import {
  readMutationReplayNudge,
  readWorkerDoneReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-executor'
import { replayMutationNudge } from './mutation-replay-nudge'
import { sendRemoteMessage } from './send-remote'
import { mayNameSession } from './session-recipient'
import { sendPointToPointMessage } from './send-point-to-point'
import { sendGroupMessage } from './send-group'
import { sendFederatedControlMail } from './send-control-mail'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { assertLifecycleCallerIsNotAnotherParty } from './lifecycle-caller-fence'

export const ORCHESTRATION_SEND_METHODS = [
  defineMethod({
    name: 'orchestration.send',
    permission: 'workspace',
    params: SendParams,
    handler: async (
      params,
      {
        runtime,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        orchestrationCompatibilityCallerAuthority,
        recordMutationReceipt,
        markWorkerDoneMutationEffectFree,
        replayedMutationReceipt,
        orchestrationCaller,
        orchestrationCompatibilityEvidence,
        signal
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const legacyReplayNudge = readWorkerDoneReplayNudge(
        'orchestration.send',
        params,
        replayedMutationReceipt
      )
      const replayNudge =
        readMutationReplayNudge(replayedMutationReceipt) ??
        (legacyReplayNudge
          ? { kind: 'messages' as const, targets: [legacyReplayNudge] }
          : undefined)
      if (replayNudge) {
        replayMutationNudge(runtime, replayNudge)
        return stripMutationReplayNudge(replayedMutationReceipt)
      }
      const from = params.from ?? 'unknown'
      const attestedCaller =
        orchestrationCompatibilityCallerAuthority?.terminalHandle === from
          ? orchestrationCompatibilityCallerAuthority
          : undefined
      const lifecycleMessage = isDispatchMutationMessageType(params.type)
      const sessionCallerAuthority =
        orchestrationCaller?.terminalHandle === from &&
        orchestrationCaller.paneKey &&
        orchestrationCaller.processIncarnation
          ? {
              terminalHandle: from,
              paneKey: orchestrationCaller.paneKey,
              processIncarnation: orchestrationCaller.processIncarnation
            }
          : undefined
      const providerCallerAuthority = attestedCaller ?? sessionCallerAuthority
      if (
        lifecycleMessage &&
        (orchestrationCaller?.terminalHandle || orchestrationCompatibilityCallerAuthority) &&
        !providerCallerAuthority
      ) {
        throw new OrchestrationError(
          'sender_not_assignee',
          'Lifecycle authority requires the authenticated caller terminal and current process incarnation; --from and copied Dispatch fields are not authority.'
        )
      }
      // Why: attested hook identity survives graph remount; caller params never supply lifecycle authority.
      const sender = orchestrationCallerIdentity(runtime, {
        handle: from,
        session: orchestrationCaller,
        paneKey: providerCallerAuthority?.paneKey ?? runtime.getTerminalPaneKey(from)
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
          processIncarnation:
            providerCallerAuthority?.processIncarnation ??
            runtime.getTerminalProcessIncarnation(from) ??
            undefined,
          signal
        })
      }

      const runGroup =
        params.to && isGroupAddress(params.to) && !params.to.toLowerCase().startsWith('@worktree:')
      // Run groups validate their own audience; message scope cannot select a parent Dispatch.
      const routing = resolveMessageRun(runtime, {
        sender,
        to: params.to,
        runId: runGroup ? undefined : params.run,
        payload: runGroup ? undefined : params.payload
      })
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
        to = `run:${routing.run.id}`
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
        if (mayNameSession(to)) {
          // Recipient routing reads the session record store, which the host opens lazily.
          await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
        }
        const recipient = resolveBareOrchestrationRecipient({
          runtime,
          db,
          handle: to,
          senderRunId: routing.run?.id,
          explicitRunId: params.run
        })
        if (!recipient.ok) {
          throw new OrchestrationError(recipient.code, recipient.message)
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
        const addressedDispatchId = to.startsWith('dispatch:')
          ? to.slice('dispatch:'.length)
          : undefined
        const federatedTarget =
          addressedDispatchId && to === `dispatch:${addressedDispatchId}`
            ? db.getFederatedDispatch(addressedDispatchId)
            : undefined
        // Federated targets perform their own liveness check before relaying.
        if (addressedDispatchId && !federatedTarget) {
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
        return sendPointToPointMessage({
          params,
          runtime,
          db,
          from,
          to,
          dispatchId: routing.dispatchId,
          messageRunId,
          senderPaneKey,
          providerAttested: Boolean(providerCallerAuthority?.processIncarnation),
          legacyCoordinatorRunId,
          resolveProcessIncarnation: () =>
            providerCallerAuthority?.processIncarnation ??
            runtime.getTerminalProcessIncarnation(from) ??
            undefined,
          revalidateLegacyCoordinator,
          recordMutationReceipt,
          markWorkerDoneMutationEffectFree,
          withSendWarnings
        })
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
  })
]
