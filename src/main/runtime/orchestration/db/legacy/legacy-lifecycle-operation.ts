import type {
  MessageType,
  MessagePriority,
  MessageRow,
  WorkerReportOutcome,
  WorkerReportSettlement,
  LegacyOperationReceiptRow
} from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

export function commitLegacyLifecycleOperation(
  this: OrchestrationDb,
  params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    message: {
      existingId?: string
      to: string
      subject: string
      body?: string
      type: MessageType
      priority?: MessagePriority
      payload?: string
    }
    lifecycle:
      | { kind: 'message_only' }
      | { kind: 'heartbeat'; at: string }
      | {
          kind: 'worker_report'
          taskId: string
          outcome: WorkerReportOutcome
          result: string
        }
  }
): {
  receipt: LegacyOperationReceiptRow
  message: MessageRow
  settlement?: WorkerReportSettlement
  duplicate: boolean
} {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.getLegacyCompatibilityPrincipal(params.principalId)
    if (
      !principal ||
      principal.role !== 'worker' ||
      !['committed', 'settled'].includes(principal.status)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Legacy compatibility principal ${params.principalId} cannot send lifecycle work.`
      )
    }
    const dispatchId = principal.dispatch_id as string
    const existingReceipt = this.requireMatchingLegacyOperationReceipt(params)
    if (existingReceipt) {
      const response = JSON.parse(existingReceipt.response_json) as {
        messageId: string
        settlement?: WorkerReportSettlement
      }
      const message = this.getMessageById(response.messageId)
      if (!message) {
        throw new OrchestrationError(
          'operation_unknown',
          `Legacy operation ${params.operationKey} lost its recorded message.`
        )
      }
      this.db.exec('COMMIT')
      return {
        receipt: existingReceipt,
        message,
        settlement: response.settlement,
        duplicate: true
      }
    }

    const dispatch = this.getDispatchContextById(dispatchId)
    if (
      !dispatch ||
      dispatch.run_id !== principal.run_id ||
      dispatch.contract_version !== LEGACY_CONTRACT_VERSION
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not this principal's legacy attempt.`
      )
    }
    if (
      (principal.status === 'settled' || !['pending', 'dispatched'].includes(dispatch.status)) &&
      (!params.message.existingId || params.lifecycle.kind !== 'worker_report')
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is settled and only matching completion reconstruction is allowed.`
      )
    }
    let message = params.message.existingId
      ? this.getMessageById(params.message.existingId)
      : undefined
    const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
      principal.run_id,
      params.message.to
    )
    if (params.message.existingId) {
      const matchesOriginalLegacyRoute =
        message?.delivery_contract === 'legacy_direct' && message.to_handle === params.message.to
      const matchesCurrentRoute =
        message?.delivery_contract === delivery.contract && message.to_handle === delivery.to
      if (
        !message ||
        message.run_id !== principal.run_id ||
        message.from_handle !== principal.terminal_handle ||
        (!matchesOriginalLegacyRoute && !matchesCurrentRoute)
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Existing legacy message ${params.message.existingId} does not match this principal.`
        )
      }
    } else {
      message = this.insertMessage({
        from: principal.terminal_handle,
        to: delivery.to,
        subject: params.message.subject,
        body: params.message.body,
        type: params.message.type,
        priority: params.message.priority,
        payload: params.message.payload,
        senderPaneKey: principal.pane_key,
        runId: principal.run_id,
        deliveryContract: delivery.contract
      })
    }

    let settlement: WorkerReportSettlement | undefined
    if (params.lifecycle.kind === 'heartbeat') {
      this.recordHeartbeat(dispatchId, params.lifecycle.at)
    } else if (params.lifecycle.kind === 'worker_report') {
      const persistedOutcome =
        params.message.existingId &&
        dispatch.task_id === params.lifecycle.taskId &&
        dispatch.status === 'completed'
          ? 'succeeded'
          : params.message.existingId &&
              dispatch.task_id === params.lifecycle.taskId &&
              dispatch.status === 'failed'
            ? 'failed'
            : undefined
      settlement = persistedOutcome
        ? { action: 'settled', outcome: persistedOutcome, duplicate: true }
        : this.settleWorkerReportInTransaction({
            taskId: params.lifecycle.taskId,
            dispatchId,
            outcome: params.lifecycle.outcome,
            result: params.lifecycle.result
          })
      if (settlement.action === 'rejected') {
        throw new OrchestrationError(settlement.code, settlement.reason)
      }
      this.db
        .prepare(
          `UPDATE legacy_compatibility_principals
           SET status = 'settled' WHERE id = ? AND status = 'committed'`
        )
        .run(principal.id)
    }
    const responseJson = JSON.stringify({ messageId: message.id, settlement })
    const receipt = this.insertLegacyOperationReceipt({
      principalId: principal.id,
      operationKey: params.operationKey,
      method: params.method,
      payloadHash: params.payloadHash,
      effectId: message.id,
      responseJson
    })
    this.db.exec('COMMIT')
    return { receipt, message, settlement, duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type LegacyLifecycleOperationMethods = {
  commitLegacyLifecycleOperation: typeof commitLegacyLifecycleOperation
}

export function attachLegacyLifecycleOperation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    commitLegacyLifecycleOperation
  })
}
