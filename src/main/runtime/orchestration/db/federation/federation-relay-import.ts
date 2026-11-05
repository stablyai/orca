import type {
  MessageType,
  MessagePriority,
  MessageRow,
  WorkerReportOutcome,
  WorkerReportSettlement
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function importFederatedRelayItem(
  this: OrchestrationDb,
  params: {
    dispatchId: string
    sequence: number
    message: {
      id: string
      runId: string
      from: string
      to: string
      subject: string
      body: string
      type: MessageType
      priority: MessagePriority
      threadId?: string
      payload?: string
    }
    lifecycle:
      | { kind: 'none' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
      | { kind: 'rejected'; code: string; reason: string }
  }
): {
  message: MessageRow
  duplicate: boolean
  lifecycle?: WorkerReportSettlement | { action: 'rejected'; code: string; reason: string }
} {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const federated = this.getFederatedDispatch(params.dispatchId)
    if (!federated) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Federated Dispatch ${params.dispatchId} was not found.`
      )
    }
    const duplicate = params.sequence <= federated.to_home_imported_sequence
    if (duplicate && !this.getMessageById(params.message.id)) {
      throw new OrchestrationError(
        'operation_unknown',
        `Federated relay sequence ${params.sequence} was committed without its message.`
      )
    }
    if (!duplicate && params.sequence !== federated.to_home_imported_sequence + 1) {
      throw new OrchestrationError(
        'operation_unknown',
        `Federated relay for ${params.dispatchId} is not contiguous after sequence ${federated.to_home_imported_sequence}.`
      )
    }

    let message = this.getMessageById(params.message.id)
    if (!message) {
      message = this.insertMessage(params.message)
    } else if (
      message.run_id !== params.message.runId ||
      message.to_handle !== params.message.to ||
      message.type !== params.message.type
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Federated relay message ${params.message.id} conflicts with an existing message.`
      )
    }
    if (message.type === 'question') {
      this.registerFederatedQuestion({
        messageId: message.id,
        runId: params.message.runId,
        dispatchId: params.dispatchId
      })
    }
    let lifecycle:
      | WorkerReportSettlement
      | { action: 'rejected'; code: string; reason: string }
      | undefined
    if (params.lifecycle.kind === 'heartbeat' && !duplicate) {
      this.recordHeartbeat(params.dispatchId, params.lifecycle.at)
    } else if (params.lifecycle.kind === 'worker_report') {
      lifecycle = this.settleWorkerReportInTransaction({
        taskId: params.lifecycle.taskId,
        dispatchId: params.dispatchId,
        outcome: params.lifecycle.outcome,
        result: params.lifecycle.result
      })
      if (lifecycle.action === 'rejected' && !duplicate) {
        message = this.convertLifecycleMessageToRejection(
          message.id,
          lifecycle.code,
          lifecycle.reason
        ) as MessageRow
      }
    } else if (params.lifecycle.kind === 'rejected') {
      lifecycle = {
        action: 'rejected',
        code: params.lifecycle.code,
        reason: params.lifecycle.reason
      }
      if (!duplicate) {
        message = this.convertLifecycleMessageToRejection(
          message.id,
          params.lifecycle.code,
          params.lifecycle.reason
        ) as MessageRow
      }
    }
    if (!duplicate) {
      this.setFederatedHomeImportSequence(params.dispatchId, params.sequence)
    }
    this.db.exec('COMMIT')
    return { message, duplicate, ...(lifecycle ? { lifecycle } : {}) }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type FederationRelayImportMethods = {
  importFederatedRelayItem: typeof importFederatedRelayItem
}

export function attachFederationRelayImport(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    importFederatedRelayItem
  })
}
