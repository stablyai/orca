import type { MessageType, OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { waitForFederatedLifecycleSettlement } from '../../orchestration/federation-lifecycle-settlement'
import { bindCoordinatorMutationPayload } from '../../orchestration/dispatch-message-binding'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../../shared/protocol-version'
import type { z } from 'zod'
import { parseRemoteWorkerPayload } from './orchestration-schemas'
import type { SendParams } from './orchestration-schemas'
import { rejectFederatedExplicitTarget } from './orchestration-routing'

type SendParamsInput = z.infer<typeof SendParams>

type RemoteAttachment = {
  dispatch_id: string
  protocol_version: number
}

export async function sendRemoteMessage(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  senderPaneKey: string
  remoteAttachment: RemoteAttachment
  processIncarnation?: string | null
  orchestrationCapability?: string
  signal?: AbortSignal
}): Promise<unknown> {
  const { params, runtime, db, from, senderPaneKey, remoteAttachment } = args
  rejectFederatedExplicitTarget(params)
  if (
    !db.verifyRemoteAttachmentAuthority({
      dispatchId: remoteAttachment.dispatch_id,
      capability: args.orchestrationCapability,
      paneKey: senderPaneKey,
      processIncarnation: args.processIncarnation ?? null
    })
  ) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The remote Dispatch capability or exact worker process is invalid.'
    )
  }

  const type = (params.type ?? 'status') as MessageType
  const payload = parseRemoteWorkerPayload(params.payload)
  if (
    typeof payload.dispatchId === 'string' &&
    payload.dispatchId !== remoteAttachment.dispatch_id
  ) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${payload.dispatchId} is not the active remote Dispatch for this pane.`
    )
  }
  const outcome =
    type === 'worker_done' && (payload.outcome === 'succeeded' || payload.outcome === 'failed')
      ? payload.outcome
      : undefined
  if (type === 'worker_done' && !outcome) {
    throw new OrchestrationError(
      'invalid_argument',
      'Remote worker_done requires outcome=succeeded|failed.'
    )
  }

  const supportsLifecycleSettlement =
    remoteAttachment.protocol_version >=
    ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
  const relay = db.enqueueFederationRelay({
    dispatchId: remoteAttachment.dispatch_id,
    direction: 'to_home',
    kind: type,
    payload: JSON.stringify({
      from,
      subject: params.subject,
      body: params.body ?? '',
      type,
      priority: params.priority ?? 'normal',
      threadId: params.threadId ?? null,
      payload: bindCoordinatorMutationPayload(type, params.payload, remoteAttachment.dispatch_id)
    }),
    ...(!supportsLifecycleSettlement && outcome ? { settleRemoteOutcome: outcome } : {})
  })
  const lifecycle =
    outcome && supportsLifecycleSettlement
      ? await waitForFederatedLifecycleSettlement(runtime, relay.dispatch_id, relay.sequence, {
          timeoutMs: 30_000,
          signal: args.signal
        })
      : outcome
        ? {
            action: outcome === 'succeeded' ? ('completed' as const) : ('failed' as const),
            authority: 'worker_server_legacy' as const
          }
        : undefined
  if (outcome && supportsLifecycleSettlement && !lifecycle) {
    throw new OrchestrationError(
      'operation_unknown',
      'worker_done was queued, but the Run-home runtime did not confirm settlement. Verify the Task and Dispatch before retrying.'
    )
  }
  return {
    relay: {
      messageId: relay.message_id,
      sequence: relay.sequence,
      dispatchId: relay.dispatch_id,
      destination: 'run_home',
      accepted: true
    },
    ...(lifecycle ? { lifecycle } : {})
  }
}
