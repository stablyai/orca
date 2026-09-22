import type { MessageDeliveryContract, MessageRow, QuestionRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { exposeQuestionTimestamps } from '../utc-timestamp'
import { legacyMessageMatchesQuestion } from '../legacy-question-identity'
import type { OrchestrationDb } from '../orchestration-db'

export function findPendingLegacyQuestions(
  this: OrchestrationDb,
  params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }
): { question: QuestionRow; message: MessageRow }[] {
  return this.findLegacyQuestionsBySemanticIdentity(params)
    .filter((row) => row.question.status === 'pending')
    .map(({ question, message }) => ({ question, message }))
}

export function findLegacyQuestionsBySemanticIdentity(
  this: OrchestrationDb,
  params: {
    principalId: string
    question: string
    options?: string[]
    recipientHandle: string
  }
): {
  question: QuestionRow
  message: MessageRow
  answerAcknowledged: boolean
  claimedByOperation: boolean
}[] {
  const principal = this.requireCommittedLegacyPrincipal(params.principalId, 'worker')
  const runAddress = `run:${principal.run_id}`
  const rows = this.db
    .prepare(
      `SELECT q.*, m.id AS source_message_id,
              EXISTS(
                SELECT 1 FROM legacy_operation_receipts lor
                WHERE lor.principal_id = ? AND lor.method = 'orchestration.ask'
                  AND lor.effect_id = q.message_id
              ) AS claimed_by_operation
       FROM question_threads q
       INNER JOIN messages m ON m.id = q.message_id
       WHERE q.run_id = ? AND q.dispatch_id = ?
         AND (
           (m.delivery_contract = 'legacy_direct' AND m.to_handle = ?) OR
           (m.delivery_contract = 'current_delivery' AND m.to_handle = ?)
         )
       ORDER BY m.sequence
       LIMIT 501`
    )
    .all(
      principal.id,
      principal.run_id,
      principal.dispatch_id,
      params.recipientHandle,
      runAddress
    ) as (QuestionRow & {
    source_message_id: string
    claimed_by_operation: number
  })[]
  if (rows.length > 500) {
    throw new OrchestrationError(
      'operation_unknown',
      'Legacy ask identity is too ambiguous to reconstruct safely.'
    )
  }
  return rows
    .filter((row) => {
      const message = this.getMessageById(row.source_message_id)
      return Boolean(
        message &&
        legacyMessageMatchesQuestion(message, params.question, params.options ?? [], [
          params.recipientHandle,
          runAddress
        ])
      )
    })
    .map((row) => ({
      question: exposeQuestionTimestamps(row),
      message: this.getMessageById(row.message_id) as MessageRow,
      claimedByOperation: row.claimed_by_operation === 1,
      answerAcknowledged: row.answer_message_id
        ? Boolean(
            this.db
              .prepare(
                `SELECT 1 FROM legacy_mail_receipts
                 WHERE principal_id = ? AND message_id = ?
                   AND acknowledged_at IS NOT NULL`
              )
              .get(principal.id, row.answer_message_id)
          )
        : false
    }))
}

export function resolveLegacyWorkerCoordinatorDelivery(
  this: OrchestrationDb,
  runId: string,
  retainedCoordinatorHandle: string
): { to: string; contract: MessageDeliveryContract } {
  const run = this.getRunRaw(runId)
  const principal = this.getLegacyCoordinatorPrincipal(runId)
  // Why: `!== null` alone reads an unknown run (undefined) as taken over and misroutes it to run: delivery.
  const takenOver = run?.coordinator_handle != null && principal?.status !== 'committed'
  return takenOver
    ? { to: `run:${runId}`, contract: 'current_delivery' }
    : { to: retainedCoordinatorHandle, contract: 'legacy_direct' }
}

export type LegacyQuestionLookupMethods = {
  findPendingLegacyQuestions: typeof findPendingLegacyQuestions
  findLegacyQuestionsBySemanticIdentity: typeof findLegacyQuestionsBySemanticIdentity
  resolveLegacyWorkerCoordinatorDelivery: typeof resolveLegacyWorkerCoordinatorDelivery
}

export function attachLegacyQuestionLookup(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    findPendingLegacyQuestions,
    findLegacyQuestionsBySemanticIdentity,
    resolveLegacyWorkerCoordinatorDelivery
  })
}
