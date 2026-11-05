import type { MessageType, OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerDispatchState } from '../../../../orchestration/types'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { waitForFederatedLifecycleSettlement } from '../../../../orchestration/federation-lifecycle-settlement'
import { bindCoordinatorMutationPayload } from '../../../../orchestration/dispatch-message-binding'
import { ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION } from '../../../../../../shared/protocol-version'
import type { z } from 'zod'
import { isDispatchMutationMessageType, parseRemoteWorkerPayload } from '../schemas'
import type { SendParams } from '../schemas'
import { FINISHED_WORKER_DONE_NEXT, WORKER_DONE_RECORDED_NEXT } from '../receipt-next'
import { assertWorkerCanReport } from '../../../../orchestration/worker-report-admission'

type SendParamsInput = z.infer<typeof SendParams>

type RemoteAttachment = {
  dispatch_id: string
  home_run_id: string
  state: WorkerDispatchState
  protocol_version: number
}

export async function sendRemoteMessage(args: {
  params: SendParamsInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  from: string
  senderPaneKey: string
  attachment: RemoteAttachment
  /** Its Dispatch has settled: the message goes to its coordinator as ordinary mail and changes nothing. */
  finished: boolean
  processIncarnation?: string | null
  signal?: AbortSignal
}) {
  const { runtime, db, from, senderPaneKey, attachment: remoteAttachment, finished } = args
  const params = finished
    ? {
        ...args.params,
        type: isDispatchMutationMessageType(args.params.type) ? 'status' : args.params.type
      }
    : args.params
  if (!finished) {
    assertWorkerCanReport({
      dispatchId: remoteAttachment.dispatch_id,
      from,
      workerState: remoteAttachment.state,
      processCurrent: db.isRemoteAttachmentProcessCurrent({
        dispatchId: remoteAttachment.dispatch_id,
        paneKey: senderPaneKey,
        processIncarnation: args.processIncarnation ?? null
      })
    })
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
  const relayed = {
    messageId: relay.message_id,
    sequence: relay.sequence,
    dispatchId: relay.dispatch_id,
    destination: 'run_home' as const,
    accepted: true as const
  }
  if (finished && args.params.type === 'worker_done') {
    // Older CLIs confirm a worker_done only by a verdict; the Task's recorded one stands.
    return {
      relay: relayed,
      lifecycle: {
        action: remoteAttachment.state === 'succeeded' ? 'completed' : 'failed',
        authority: 'run_home'
      },
      next: FINISHED_WORKER_DONE_NEXT
    }
  }
  return {
    relay: relayed,
    ...(lifecycle ? { lifecycle } : {}),
    ...(lifecycle && lifecycle.action !== 'rejected' ? { next: WORKER_DONE_RECORDED_NEXT } : {})
  }
}
