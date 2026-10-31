import type { MessageRow, QuestionRow } from '../../types'
import { OrchestrationError } from '../../orchestration-error'
import { exposeQuestionTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import { handHelperMailToRun } from '../messages/helper-mailbox-hand-back'

export function createQuestion(
  this: OrchestrationDb,
  params: {
    runId: string
    dispatchId: string
    askerHandle: string
    question: string
    options?: string[]
    /** The asker's report mailbox; the Run when omitted. */
    to?: string
  }
): { question: QuestionRow; message: MessageRow } {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.requireRun(params.runId)
    const dispatch = this.getDispatchContextById(params.dispatchId)
    if (
      !dispatch ||
      dispatch.run_id !== params.runId ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Dispatch ${params.dispatchId} is not active in Run ${params.runId}.`
      )
    }
    const message = this.insertMessage({
      from: `dispatch:${params.dispatchId}`,
      to: params.to ?? `run:${params.runId}`,
      subject: 'Question',
      body: params.question,
      type: 'question',
      payload: JSON.stringify({
        taskId: dispatch.task_id,
        dispatchId: dispatch.id,
        question: params.question,
        options: params.options ?? []
      }),
      runId: params.runId
    })
    this.db.prepare('UPDATE messages SET thread_id = ? WHERE id = ?').run(message.id, message.id)
    this.db
      .prepare(
        `INSERT INTO question_threads (
           message_id, run_id, dispatch_id, asker_handle
         ) VALUES (?, ?, ?, ?)`
      )
      .run(message.id, params.runId, params.dispatchId, params.askerHandle)
    const question = this.getQuestionRaw(message.id) as QuestionRow
    const storedMessage = this.getMessageById(message.id) as MessageRow
    this.db.exec('COMMIT')
    return { question: exposeQuestionTimestamps(question), message: storedMessage }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getQuestion(this: OrchestrationDb, messageId: string): QuestionRow | undefined {
  const question = this.getQuestionRaw(messageId)
  return question ? exposeQuestionTimestamps(question) : undefined
}

export function getQuestionRaw(this: OrchestrationDb, messageId: string): QuestionRow | undefined {
  return this.db.prepare('SELECT * FROM question_threads WHERE message_id = ?').get(messageId) as
    | QuestionRow
    | undefined
}

export function answerQuestion(
  this: OrchestrationDb,
  params: {
    messageId: string
    runId: string
    body: string
  } & (
    | { consumerGeneration: number }
    /** A worker answering its own helper, fenced on its Dispatch instead of the Run's consumer. */
    | { answeredBy: { dispatchId: string; consumerGeneration: number } }
  )
): { question: QuestionRow; message: MessageRow; duplicate: boolean } {
  const answeredBy = 'answeredBy' in params ? params.answeredBy : null
  const byDispatch = answeredBy?.dispatchId ?? null
  const generation = 'consumerGeneration' in params ? params.consumerGeneration : null
  this.db.exec('BEGIN IMMEDIATE')
  try {
    if (generation !== null) {
      this.requireCurrentConsumer(params.runId, generation)
    }
    const question = this.getQuestionRaw(params.messageId)
    if (!question || question.run_id !== params.runId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${params.messageId} was not found in Run ${params.runId}.`
      )
    }
    if (answeredBy !== null) {
      const answerer = this.getDispatchContextById(answeredBy.dispatchId)
      if (
        this.getMessageById(question.message_id)?.to_handle !==
          `dispatch:${answeredBy.dispatchId}` ||
        (answerer?.status !== 'pending' && answerer?.status !== 'dispatched') ||
        answerer.consumer_generation !== answeredBy.consumerGeneration
      ) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Question ${params.messageId} was not asked of active Dispatch ${answeredBy.dispatchId}.`
        )
      }
    }
    if (question.status === 'closed') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${params.messageId} is closed because its Dispatch is inactive.`
      )
    }
    if (question.status === 'answered') {
      if (question.answer_body !== params.body || !question.answer_message_id) {
        throw new OrchestrationError(
          'answer_conflict',
          `Question ${params.messageId} already has a different answer.`
        )
      }
      const message = this.getMessageById(question.answer_message_id)
      if (!message) {
        throw new Error(`Recorded answer message ${question.answer_message_id} was not found.`)
      }
      this.db.exec('COMMIT')
      return { question: exposeQuestionTimestamps(question), message, duplicate: true }
    }

    const message = this.insertMessage({
      from: byDispatch !== null ? `dispatch:${byDispatch}` : `run:${params.runId}`,
      to: `dispatch:${question.dispatch_id}`,
      subject: 'Re: Question',
      body: params.body,
      threadId: question.message_id,
      runId: params.runId
    })
    // The answer is the worker's mail; a federated worker's copy lives on its execution host.
    if (this.getFederatedDispatch(question.dispatch_id)) {
      this.markAsReadAndDelivered([message.id])
    }
    this.db
      .prepare(
        `UPDATE question_threads
         SET status = 'answered', answer_message_id = ?, answer_body = ?,
             answered_by_generation = ?, answered_at = datetime('now')
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(message.id, params.body, generation, question.message_id)
    const answered = this.getQuestionRaw(question.message_id) as QuestionRow
    const storedMessage = this.getMessageById(message.id) as MessageRow
    this.db.exec('COMMIT')
    return {
      question: exposeQuestionTimestamps(answered),
      message: storedMessage,
      duplicate: false
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

/** Whether the Dispatch's last turn ended on its own pending question: no mail has reached it since it asked. */
export function awaitsAnswerToLatestQuestion(this: OrchestrationDb, dispatchId: string): boolean {
  const row = this.db
    .prepare(
      `SELECT EXISTS (
         SELECT 1 FROM question_threads q JOIN messages asked ON asked.id = q.message_id
          WHERE q.dispatch_id = ? AND q.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM messages m
               WHERE m.to_handle = 'dispatch:' || q.dispatch_id AND m.sequence > asked.sequence
            )
       ) OR EXISTS (
         -- A paired worker's question lives at its Run home, so only its timestamp orders it here.
         SELECT 1 FROM remote_questions q
          WHERE q.dispatch_id = ? AND q.status = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM messages m
               WHERE m.to_handle = 'dispatch:' || q.dispatch_id AND m.created_at > q.created_at
            )
       ) AS pending`
    )
    .get(dispatchId, dispatchId)
  return row?.pending === 1
}

export function closeQuestionsForDispatch(this: OrchestrationDb, dispatchId: string): string[] {
  // Every settlement passes here, so transfer helper mail to the Run here too.
  handHelperMailToRun(this, dispatchId)
  const rows = this.db
    .prepare("SELECT message_id FROM question_threads WHERE dispatch_id = ? AND status = 'pending'")
    .all(dispatchId) as { message_id: string }[]
  if (rows.length === 0) {
    return []
  }
  this.db
    .prepare(
      "UPDATE question_threads SET status = 'closed', closed_at = datetime('now') WHERE dispatch_id = ? AND status = 'pending'"
    )
    .run(dispatchId)
  return rows.map((row) => row.message_id)
}

export type QuestionThreadsMethods = {
  createQuestion: typeof createQuestion
  getQuestion: typeof getQuestion
  getQuestionRaw: typeof getQuestionRaw
  answerQuestion: typeof answerQuestion
  awaitsAnswerToLatestQuestion: typeof awaitsAnswerToLatestQuestion
  closeQuestionsForDispatch: typeof closeQuestionsForDispatch
}

export function attachQuestionThreads(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createQuestion,
    getQuestion,
    getQuestionRaw,
    answerQuestion,
    awaitsAnswerToLatestQuestion,
    closeQuestionsForDispatch
  })
}
