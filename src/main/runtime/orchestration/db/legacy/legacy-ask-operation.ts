import type { MessageRow, LegacyOperationReceiptRow, QuestionRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import { legacyMessageMatchesQuestion } from '../legacy-question-identity'
import type { OrchestrationDb } from '../orchestration-db'

export function commitLegacyAskOperation(
  this: OrchestrationDb,
  params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    question: string
    options?: string[]
    recipientHandle: string
    existingQuestionId?: string
  }
): {
  receipt: LegacyOperationReceiptRow
  question: QuestionRow
  message: MessageRow
  duplicate: boolean
} {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
    const receipt = this.requireMatchingLegacyOperationReceipt(params)
    if (receipt) {
      const response = JSON.parse(receipt.response_json) as { questionId: string }
      const question = this.getQuestion(response.questionId)
      const message = this.getMessageById(response.questionId)
      if (!question || !message) {
        throw new OrchestrationError(
          'operation_unknown',
          `Legacy ask ${params.operationKey} lost its durable question.`
        )
      }
      this.db.exec('COMMIT')
      return { receipt, question, message, duplicate: true }
    }

    const dispatchId = principal.dispatch_id as string
    const dispatch = this.getDispatchContextById(dispatchId)
    if (
      !dispatch ||
      dispatch.run_id !== principal.run_id ||
      dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
      !['pending', 'dispatched'].includes(dispatch.status)
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${dispatchId} is not an active legacy attempt.`
      )
    }

    const existingQuestionId =
      params.existingQuestionId &&
      !this.db
        .prepare(
          `SELECT 1 FROM legacy_operation_receipts
           WHERE principal_id = ? AND method = 'orchestration.ask' AND effect_id = ?
           LIMIT 1`
        )
        .get(principal.id, params.existingQuestionId)
        ? params.existingQuestionId
        : undefined
    let question: QuestionRow
    let message: MessageRow
    const delivery = this.resolveLegacyWorkerCoordinatorDelivery(
      principal.run_id,
      params.recipientHandle
    )
    if (existingQuestionId) {
      const existingQuestion = this.getQuestion(existingQuestionId)
      const existingMessage = this.getMessageById(existingQuestionId)
      if (
        !existingQuestion ||
        !existingMessage ||
        existingQuestion.run_id !== principal.run_id ||
        existingQuestion.dispatch_id !== dispatchId ||
        existingQuestion.status !== 'pending' ||
        existingMessage.delivery_contract !== delivery.contract ||
        !legacyMessageMatchesQuestion(existingMessage, params.question, params.options ?? [], [
          delivery.to
        ])
      ) {
        throw new OrchestrationError(
          'request_mismatch',
          `Question ${params.existingQuestionId} is not a pending ask for this principal.`
        )
      }
      question = existingQuestion
      message = existingMessage
    } else {
      message = this.insertMessage({
        from: principal.terminal_handle,
        to: delivery.to,
        subject: 'Question',
        body: params.question,
        type: delivery.contract === 'legacy_direct' ? 'decision_gate' : 'question',
        payload: JSON.stringify({
          taskId: dispatch.task_id,
          dispatchId,
          question: params.question,
          options: params.options ?? []
        }),
        senderPaneKey: principal.pane_key,
        runId: principal.run_id,
        deliveryContract: delivery.contract
      })
      this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(message.id, message.id)
      this.db
        .prepare(
          `INSERT INTO question_threads (
             message_id, run_id, dispatch_id, asker_handle
           ) VALUES (?, ?, ?, ?)`
        )
        .run(message.id, principal.run_id, dispatchId, principal.terminal_handle)
      question = this.getQuestion(message.id) as QuestionRow
      message = this.getMessageById(message.id) as MessageRow
    }

    const committedReceipt = this.insertLegacyOperationReceipt({
      principalId: principal.id,
      operationKey: params.operationKey,
      method: params.method,
      payloadHash: params.payloadHash,
      effectId: question.message_id,
      responseJson: JSON.stringify({ questionId: question.message_id })
    })
    this.db.exec('COMMIT')
    return { receipt: committedReceipt, question, message, duplicate: false }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type LegacyAskOperationMethods = {
  commitLegacyAskOperation: typeof commitLegacyAskOperation
}

export function attachLegacyAskOperation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    commitLegacyAskOperation
  })
}
