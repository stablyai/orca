import type { MessagePriority, MessageType, OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { encodeFederatedControlMessage } from '../../orchestration/federation-control-message'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import type { SendParams } from './orchestration-schemas'
import type { SendRecipientWarning } from './orchestration-recipient-routing'
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
    withSendWarnings
  } = args
  const dispatchId = to.startsWith('dispatch:') ? to.slice('dispatch:'.length) : undefined
  const federatedTarget =
    dispatchId && to === `dispatch:${dispatchId}` ? db.getFederatedDispatch(dispatchId) : undefined
  if (!federatedTarget || !dispatchId) {
    return undefined
  }
  if (federatedTarget.protocol_version < ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Federated Dispatch ${dispatchId} does not support coordinator control mail; start a fresh worker after updating its Orca server.`
    )
  }
  if (db.getWorkerDispatch(dispatchId)?.state !== 'ready') {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Federated Dispatch ${dispatchId} is not active.`
    )
  }
  if (params.type === 'worker_done' || params.type === 'heartbeat') {
    throw new OrchestrationError(
      'invalid_argument',
      'Coordinator-to-worker control mail cannot report worker lifecycle.'
    )
  }
  revalidateLegacyCoordinator?.()
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
      payload: params.payload ?? null
    })
  })
  runtime.ensureOrchestrationFederationRelay(messageRunId)
  return withSendWarnings({
    relay: {
      messageId: relay.message_id,
      sequence: relay.sequence,
      dispatchId: relay.dispatch_id,
      destination: 'worker',
      accepted: true
    }
  })
}
