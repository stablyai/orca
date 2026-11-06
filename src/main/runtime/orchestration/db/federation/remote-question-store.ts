import { importedAnswerSenderSnapshot } from '../../answer-sender-relay-report'
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
  answerSenderReport?: unknown
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
  this.db.exec('SAVEPOINT remote_answer_mail')
  try {
    const fresh = classifyRemoteQuestion.call(this, params) !== 'settled'
    if (fresh) {
      const updated = this.db
        .prepare(`UPDATE remote_questions
        SET status = 'answered', answer_message_id = ?, answer_body = ?, answered_at = datetime('now')
        WHERE message_id = ? AND status = 'pending'`)
        .run(params.answerMessageId, params.body, params.messageId)
      if (updated.changes === 0 && classifyRemoteQuestion.call(this, params) !== 'settled') {
        throw new OrchestrationError('answer_conflict', 'The remote answer could not be stored.')
      }
    }
    storeRemoteAnswerMail.call(this, params, fresh)
    this.db.exec('RELEASE remote_answer_mail')
  } catch (error) {
    this.db.exec('ROLLBACK TO remote_answer_mail')
    this.db.exec('RELEASE remote_answer_mail')
    throw error
  }
}

/** The answer is the worker's Dispatch mail on its execution host, as at a local Run home. */
function storeRemoteAnswerMail(
  this: OrchestrationDb,
  params: RemoteAnswerParams,
  fresh: boolean
): void {
  const homeRunId = this.getRemoteDispatchAttachment(params.dispatchId)?.home_run_id
  if (!homeRunId) {
    return
  }
  const existing = this.getMessageById(params.answerMessageId)
  if (existing) {
    if (
      existing.run_id !== homeRunId ||
      existing.from_handle !== `run:${homeRunId}` ||
      existing.to_handle !== `dispatch:${params.dispatchId}` ||
      existing.subject !== 'Re: Question' ||
      existing.body !== params.body ||
      existing.thread_id !== params.messageId ||
      existing.type !== 'status'
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        'The remote answer conflicts with an existing message.'
      )
    }
    return
  }
  // A replay cannot enrich a previously accepted answer that lacked an event snapshot.
  this.insertMessage({
    id: params.answerMessageId,
    runId: homeRunId,
    from: `run:${homeRunId}`,
    to: `dispatch:${params.dispatchId}`,
    subject: 'Re: Question',
    answerSenderSnapshot: fresh
      ? importedAnswerSenderSnapshot(params.answerSenderReport, `run:${homeRunId}`)
      : undefined,
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
