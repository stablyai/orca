import type { MessagePriority, MessageType } from '../db/orchestration-records'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../orchestration-error'
import { callerMailProvenance } from '../db/messages/message-orca-provenance'
import { pairedServerSendRefusal } from '../paired-server-follow-up-refusal'
import { encodeFederatedControlMessage } from '../legacy-remote/federation-control-message'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { recordReceiptBeforeNudge } from '../../rpc/methods/orchestration/messaging/mutation-replay-nudge'
import type { SendParams } from '../../rpc/methods/orchestration/messaging/send-params'
import type { SendRecipientWarning } from '../../rpc/methods/orchestration/messaging/recipient-routing'
import type { z } from 'zod'

type SendParamsInput = z.infer<typeof SendParams>
type SendReceipt = <T extends object>(receipt: T) => T & { warnings?: SendRecipientWarning[] }

/** Delivers coordinator control mail to a federated worker when `to` names its exact Dispatch. */
export function sendFederatedControlMail(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  to: string
  messageRunId: string | undefined
  revalidateLegacyCoordinator: (() => string) | undefined
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
  withSendWarnings: SendReceipt
}): unknown {
  const {
    params,
    runtime,
    db,
    from,
    to,
    messageRunId,
    revalidateLegacyCoordinator,
    recordMutationReceipt,
    withSendWarnings
  } = args
  const dispatchId = to.startsWith('dispatch:') ? to.slice('dispatch:'.length) : undefined
  const federatedTarget =
    dispatchId && to === `dispatch:${dispatchId}` ? db.getFederatedDispatch(dispatchId) : undefined
  if (!federatedTarget || !dispatchId) {
    return undefined
  }
  let state: string | undefined
  const refusal = federatedControlMailRefusal(
    dispatchId,
    federatedTarget.protocol_version,
    () => (state = db.getWorkerDispatch(dispatchId)?.state)
  )
  if (refusal) {
    throw new OrchestrationError(
      refusal.code,
      refusal.code !== 'dispatch_inactive'
        ? refusal.message
        : pairedServerSendRefusal(dispatchId, federatedTarget.environment_name, state)
    )
  }
  if (params.type === 'worker_done' || params.type === 'heartbeat') {
    throw new OrchestrationError(
      'invalid_argument',
      'Coordinator-to-worker control mail cannot report worker lifecycle.'
    )
  }
  revalidateLegacyCoordinator?.()
  // Refused here, not on the paired Orca's import, where a refusal would stall its relay.
  const callerPayload = callerMailProvenance({ from, payload: params.payload })
  const relay = db.enqueueFederationRelay({
    dispatchId,
    direction: 'to_worker',
    kind: 'control_message',
    payload: encodeFederatedControlMessage({
      from,
      subject: params.subject,
      body: params.body ?? '',
      type: (params.type ?? 'status') as MessageType,
      priority: (params.priority ?? 'normal') as MessagePriority,
      threadId: params.threadId ?? null,
      payload: callerPayload ?? null
    })
  })
  const receipt = withSendWarnings({
    relay: {
      messageId: relay.message_id,
      sequence: relay.sequence,
      dispatchId: relay.dispatch_id,
      destination: 'worker',
      accepted: true
    }
  })
  return recordReceiptBeforeNudge(
    recordMutationReceipt,
    receipt,
    () => runtime.ensureOrchestrationFederationRelay(messageRunId),
    { kind: 'federation', ...(messageRunId ? { runId: messageRunId } : {}) }
  )
}

export function federatedControlMailRefusal(
  dispatchId: string,
  protocolVersion: number,
  workerState: () => string | undefined
): { code: 'capability_unsupported' | 'dispatch_inactive'; message: string } | undefined {
  if (protocolVersion < ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION) {
    return {
      code: 'capability_unsupported',
      message: `Federated Dispatch ${dispatchId} does not support coordinator control mail; start a fresh worker after updating its Orca server.`
    }
  }
  if (workerState() !== 'ready') {
    return { code: 'dispatch_inactive', message: `Federated Dispatch ${dispatchId} is not active.` }
  }
  return undefined
}
