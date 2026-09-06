import { defineMethod, type RpcMethod } from '../core'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { isGroupAddress } from '../../orchestration/groups'
import { orchestrationSkillRecoveryData } from '../../../../shared/orchestration-rpc-contract'
import {
  SendParams,
  isWorkerReportOutcome,
  parseRemoteWorkerPayload
} from './orchestration-schemas'
import { resolveMessageRun } from './orchestration-routing'
import {
  assertDispatchMailboxDeliverable,
  resolveBareOrchestrationRecipient,
  type SendRecipientWarning
} from './orchestration-recipient-routing'
import { sendRemoteMessage } from './orchestration-send-remote'
import { sendPointToPointMessage } from './orchestration-send-point-to-point'
import { sendGroupMessage } from './orchestration-send-group'
import { sendFederatedControlMail } from './orchestration-send-control-mail'

export const ORCHESTRATION_SEND_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (
      params,
      {
        runtime,
        orchestrationCapability,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        orchestrationCompatibilityCallerAuthority,
        recordMutationReceipt,
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
      const senderPaneKey = attestedCaller?.paneKey ?? runtime.getTerminalPaneKey(from) ?? undefined
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
            attestedCaller?.processIncarnation ??
            runtime.getTerminalProcessIncarnation(from) ??
            undefined,
          orchestrationCapability,
          signal
        })
      }

      const routing = resolveMessageRun(runtime, {
        from,
        senderPaneKey,
        to: params.to,
        runId: params.run,
        payload: params.payload
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
          assertDispatchMailboxDeliverable(db, addressedDispatchId)
        }
        const federatedControl = sendFederatedControlMail({
          params,
          runtime,
          db,
          from,
          to,
          messageRunId,
          revalidateLegacyCoordinator,
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
          legacyCoordinatorRunId,
          orchestrationCapability,
          resolveProcessIncarnation: () =>
            attestedCaller?.processIncarnation ??
            runtime.getTerminalProcessIncarnation(from) ??
            undefined,
          revalidateLegacyCoordinator,
          withSendWarnings
        })
      }
      return sendGroupMessage({
        params,
        runtime,
        db,
        from,
        groupAddress: to,
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
