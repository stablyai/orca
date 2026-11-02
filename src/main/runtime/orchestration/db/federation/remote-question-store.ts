import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export function getRemoteQuestion(
  this: OrchestrationDb,
  messageId: string
):
  | {
      message_id: string
      dispatch_id: string
      status: 'pending' | 'answered' | 'closed'
      answer_message_id: string | null
      answer_body: string | null
    }
  | undefined {
  return this.db.prepare('SELECT * FROM remote_questions WHERE message_id = ?').get(messageId) as
    | {
        message_id: string
        dispatch_id: string
        status: 'pending' | 'answered' | 'closed'
        answer_message_id: string | null
        answer_body: string | null
      }
    | undefined
}

type RemoteAnswerParams = {
  messageId: string
  dispatchId: string
  answerMessageId: string
  body: string
}

function classifyRemoteQuestion(
  this: OrchestrationDb,
  params: RemoteAnswerParams
): 'settled' | 'writable' {
  const question = this.getRemoteQuestion(params.messageId)
  if (!question || question.dispatch_id !== params.dispatchId) {
    throw new OrchestrationError(
      'question_not_found',
      `Remote Question ${params.messageId} was not found.`
    )
  }
  if (question.status === 'answered') {
    if (
      question.answer_message_id !== params.answerMessageId ||
      question.answer_body !== params.body
    ) {
      throw new OrchestrationError(
        'answer_conflict',
        `Remote Question ${params.messageId} already has a different answer.`
      )
    }
    return 'settled'
  }
  // Refuse closed questions explicitly; a guarded no-op UPDATE could otherwise look stored.
  if (question.status === 'closed') {
    throw new OrchestrationError(
      'question_not_found',
      `Remote Question ${params.messageId} is closed.`
    )
  }
  return 'writable'
}

export function answerRemoteQuestion(this: OrchestrationDb, params: RemoteAnswerParams): void {
  if (classifyRemoteQuestion.call(this, params) !== 'settled') {
    const changes = this.db
      .prepare(
        `UPDATE remote_questions
         SET status = 'answered', answer_message_id = ?, answer_body = ?,
             answered_at = datetime('now')
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(params.answerMessageId, params.body, params.messageId).changes
    // Reclassify a lost UPDATE race so concurrent answer/close is reported honestly.
    if (changes === 0 && classifyRemoteQuestion.call(this, params) !== 'settled') {
      throw new OrchestrationError(
        'answer_conflict',
        `Remote Question ${params.messageId} could not be answered.`
      )
    }
  }
  storeRemoteAnswerMail.call(this, params)
}

/** The answer is the worker's Dispatch mail on its execution host, as at a local Run home. */
function storeRemoteAnswerMail(this: OrchestrationDb, params: RemoteAnswerParams): void {
  const homeRunId = this.getRemoteDispatchAttachment(params.dispatchId)?.home_run_id
  if (!homeRunId || this.getMessageById(params.answerMessageId)) {
    return
  }
  this.insertMessage({
    id: params.answerMessageId,
    runId: homeRunId,
    from: `run:${homeRunId}`,
    to: `dispatch:${params.dispatchId}`,
    subject: 'Re: Question',
    body: params.body,
    threadId: params.messageId
  })
}

export function setRemoteWorkerImportSequence(
  this: OrchestrationDb,
  dispatchId: string,
  sequence: number
): void {
  this.db
    .prepare(
      `UPDATE remote_dispatch_attachments
       SET to_worker_imported_sequence = ?, updated_at = datetime('now')
       WHERE dispatch_id = ? AND to_worker_imported_sequence < ?`
    )
    .run(sequence, dispatchId, sequence)
}

export function registerFederatedQuestion(
  this: OrchestrationDb,
  params: {
    messageId: string
    runId: string
    dispatchId: string
  }
): void {
  this.db
    .prepare(
      `INSERT OR IGNORE INTO question_threads (
         message_id, run_id, dispatch_id, asker_handle
       ) VALUES (?, ?, ?, ?)`
    )
    .run(params.messageId, params.runId, params.dispatchId, `dispatch:${params.dispatchId}`)
}

export type RemoteQuestionStoreMethods = {
  getRemoteQuestion: typeof getRemoteQuestion
  answerRemoteQuestion: typeof answerRemoteQuestion
  setRemoteWorkerImportSequence: typeof setRemoteWorkerImportSequence
  registerFederatedQuestion: typeof registerFederatedQuestion
}

export function attachRemoteQuestionStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    getRemoteQuestion,
    answerRemoteQuestion,
    setRemoteWorkerImportSequence,
    registerFederatedQuestion
  })
}
