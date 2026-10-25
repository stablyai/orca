import type {
  WorkerReportOutcome,
  FederationRelayDirection,
  FederationRelayItemRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import { isWorkerStateIn, SETTLEABLE_WORKER_STATES } from '../../worker-report-admission'

export function getFederationRelayItem(
  this: OrchestrationDb,
  dispatchId: string,
  direction: FederationRelayDirection,
  sequence: number
): FederationRelayItemRow | undefined {
  return this.db
    .prepare(
      `SELECT * FROM federation_relay_items
       WHERE dispatch_id = ? AND direction = ? AND sequence = ?`
    )
    .get(dispatchId, direction, sequence) as FederationRelayItemRow | undefined
}

export function settleRemoteAttachmentInRelayTransaction(
  this: OrchestrationDb,
  dispatchId: string,
  outcome: WorkerReportOutcome | undefined,
  stage = 'worker_report_queued'
): void {
  if (!outcome) {
    return
  }
  const attachment = this.getRemoteDispatchAttachment(dispatchId)
  const state = outcome === 'succeeded' ? 'succeeded' : 'failed'
  if (!attachment) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Remote Dispatch ${dispatchId} was not found.`
    )
  }
  if (attachment.state === state) {
    return
  }
  if (!isWorkerStateIn(SETTLEABLE_WORKER_STATES, attachment.state)) {
    throw new OrchestrationError(
      'request_mismatch',
      `Remote Dispatch ${dispatchId} cannot settle as ${state} from ${attachment.state}.`
    )
  }
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET state = ?, stage = ?, capability_hash = NULL,
           updated_at = datetime('now')
       WHERE dispatch_id = ? AND state = ?`
    )
    .run(state, stage, dispatchId, attachment.state)
}

export type FederationRelayItemMethods = {
  getFederationRelayItem: typeof getFederationRelayItem
  settleRemoteAttachmentInRelayTransaction: typeof settleRemoteAttachmentInRelayTransaction
}

export function attachFederationRelayItem(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getFederationRelayItem,
    settleRemoteAttachmentInRelayTransaction
  })
}
