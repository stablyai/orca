import type { LegacyMailReceiptRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { LEGACY_CONTRACT_VERSION } from '../contract-constants'
import type { OrchestrationDb } from '../orchestration-db'

export function acknowledgeLegacyQuestionAnswer(
  this: OrchestrationDb,
  params: {
    principalId: string
    questionId: string
    answerMessageId: string
  }
): { receipt: LegacyMailReceiptRow; duplicate: boolean } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const principal = this.requireLegacyMailPrincipal(params.principalId, 'worker')
    const question = this.getQuestionRaw(params.questionId)
    const source = this.getMessageById(params.questionId)
    const answer = this.getMessageById(params.answerMessageId)
    const dispatch = principal.dispatch_id
      ? this.getDispatchContextById(principal.dispatch_id)
      : undefined
    const exactLegacyAnswer =
      answer?.delivery_contract === 'legacy_direct' &&
      (answer.to_handle === principal.terminal_handle ||
        answer.to_handle === `dispatch:${principal.dispatch_id}`)
    const adoption = this.getLegacyAdoption()
    const exactTakenOverAnswer =
      adoption?.adopted_run_id === principal.run_id &&
      dispatch?.run_id === principal.run_id &&
      dispatch.contract_version === LEGACY_CONTRACT_VERSION &&
      source?.run_id === principal.run_id &&
      source.from_handle === principal.terminal_handle &&
      source.to_handle === `run:${principal.run_id}` &&
      source.delivery_contract === 'current_delivery' &&
      answer?.run_id === principal.run_id &&
      answer?.delivery_contract === 'current_delivery' &&
      answer.from_handle === `run:${principal.run_id}` &&
      answer.to_handle === `dispatch:${principal.dispatch_id}` &&
      answer.thread_id === question?.message_id
    if (
      !question ||
      !answer ||
      question.run_id !== principal.run_id ||
      question.dispatch_id !== principal.dispatch_id ||
      question.answer_message_id !== params.answerMessageId ||
      (!exactLegacyAnswer && !exactTakenOverAnswer)
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        'Legacy answer acknowledgment does not match this principal question.'
      )
    }
    const existing = this.db
      .prepare(
        `SELECT * FROM legacy_mail_receipts
         WHERE principal_id = ? AND message_id = ?`
      )
      .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow | undefined
    this.db
      .prepare(
        `UPDATE messages
         SET read = 1, delivered_at = COALESCE(delivered_at, datetime('now'))
         WHERE id = ?`
      )
      .run(params.answerMessageId)
    this.db
      .prepare(
        `INSERT INTO legacy_mail_receipts (
           principal_id, message_id, acknowledged_at
         ) VALUES (?, ?, datetime('now'))
         ON CONFLICT(principal_id, message_id)
         DO UPDATE SET acknowledged_at = COALESCE(
           legacy_mail_receipts.acknowledged_at, excluded.acknowledged_at
         )`
      )
      .run(params.principalId, params.answerMessageId)
    const receipt = this.db
      .prepare(
        `SELECT * FROM legacy_mail_receipts
         WHERE principal_id = ? AND message_id = ?`
      )
      .get(params.principalId, params.answerMessageId) as LegacyMailReceiptRow
    this.db.exec('COMMIT')
    return { receipt, duplicate: Boolean(existing?.acknowledged_at) }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export type LegacyQuestionAcknowledgeMethods = {
  acknowledgeLegacyQuestionAnswer: typeof acknowledgeLegacyQuestionAnswer
}

export function attachLegacyQuestionAcknowledge(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    acknowledgeLegacyQuestionAnswer
  })
}
