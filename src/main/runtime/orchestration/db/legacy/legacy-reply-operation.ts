import type { MessageRow, LegacyOperationReceiptRow, QuestionRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

export function commitLegacyReplyOperation(
  this: OrchestrationDb,
  params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    questionId: string
    body: string
  }
): {
  receipt: LegacyOperationReceiptRow
  question: QuestionRow
  message: MessageRow
  duplicate: boolean
} {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'coordinator')
    const receipt = this.requireMatchingLegacyOperationReceipt(params)
    if (receipt) {
      const response = JSON.parse(receipt.response_json) as {
        questionId: string
        messageId: string
      }
      const question = this.getQuestion(response.questionId)
      const message = this.getMessageById(response.messageId)
      if (!question || !message) {
        throw new OrchestrationError(
          'operation_unknown',
          `Legacy reply ${params.operationKey} lost its durable effect.`
        )
      }
      this.db.exec('COMMIT')
      return { receipt, question, message, duplicate: true }
    }

    const question = this.getQuestionRaw(params.questionId)
    const sourceMessage = this.getMessageById(params.questionId)
    const dispatch = question ? this.getDispatchContextById(question.dispatch_id) : undefined
    if (
      !question ||
      !sourceMessage ||
      !dispatch ||
      question.run_id !== principal.run_id ||
      sourceMessage.delivery_contract !== 'legacy_direct' ||
      dispatch.run_id !== principal.run_id ||
      dispatch.contract_version !== LEGACY_CONTRACT_VERSION ||
      question.status === 'closed'
    ) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${params.questionId} is not actionable in the adopted Run.`
      )
    }
    let message: MessageRow
    if (question.status === 'answered') {
      if (question.answer_body !== params.body || !question.answer_message_id) {
        throw new OrchestrationError(
          'answer_conflict',
          `Question ${params.questionId} already has a different answer.`
        )
      }
      message = this.getMessageById(question.answer_message_id) as MessageRow
      if (
        !message ||
        message.run_id !== principal.run_id ||
        message.delivery_contract !== 'legacy_direct'
      ) {
        throw new OrchestrationError(
          'operation_unknown',
          `Question ${params.questionId} lost its recorded answer message.`
        )
      }
    } else {
      message = this.insertMessage({
        from: principal.terminal_handle,
        to: question.asker_handle,
        subject: 'Re: Question',
        body: params.body,
        threadId: question.message_id,
        runId: principal.run_id,
        deliveryContract: 'legacy_direct'
      })
      this.markAsRead([question.message_id])
      this.db
        .prepare(
          `UPDATE question_threads
           SET status = 'answered', answer_message_id = ?, answer_body = ?,
               answered_at = datetime('now')
           WHERE message_id = ? AND status = 'pending'`
        )
        .run(message.id, params.body, question.message_id)
    }

    const answered = this.getQuestion(params.questionId) as QuestionRow
    const committedReceipt = this.insertLegacyOperationReceipt({
      principalId: principal.id,
      operationKey: params.operationKey,
      method: params.method,
      payloadHash: params.payloadHash,
      effectId: message.id,
      responseJson: JSON.stringify({
        questionId: answered.message_id,
        messageId: message.id
      })
    })
    this.db.exec('COMMIT')
    return {
      receipt: committedReceipt,
      question: answered,
      message,
      duplicate: question.status === 'answered'
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function requireMatchingLegacyOperationReceipt(
  this: OrchestrationDb,
  params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
  }
): LegacyOperationReceiptRow | undefined {
  const receipt = this.getLegacyOperationReceipt(params.principalId, params.operationKey)
  if (
    receipt &&
    (receipt.method !== params.method || receipt.payload_hash !== params.payloadHash)
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Legacy operation ${params.operationKey} was already used with different input.`
    )
  }
  return receipt
}

export function insertLegacyOperationReceipt(
  this: OrchestrationDb,
  params: {
    principalId: string
    operationKey: string
    method: string
    payloadHash: string
    effectId: string
    responseJson: string
  }
): LegacyOperationReceiptRow {
  this.db
    .prepare(
      `INSERT INTO legacy_operation_receipts (
         principal_id, operation_key, method, payload_hash, effect_id, response_json
       ) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.principalId,
      params.operationKey,
      params.method,
      params.payloadHash,
      params.effectId,
      params.responseJson
    )
  return this.getLegacyOperationReceipt(
    params.principalId,
    params.operationKey
  ) as LegacyOperationReceiptRow
}

export type LegacyReplyOperationMethods = {
  commitLegacyReplyOperation: typeof commitLegacyReplyOperation
  requireMatchingLegacyOperationReceipt: typeof requireMatchingLegacyOperationReceipt
  insertLegacyOperationReceipt: typeof insertLegacyOperationReceipt
}

export function attachLegacyReplyOperation(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    commitLegacyReplyOperation,
    requireMatchingLegacyOperationReceipt,
    insertLegacyOperationReceipt
  })
}
