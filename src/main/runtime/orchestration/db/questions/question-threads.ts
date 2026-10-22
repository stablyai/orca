import type { MessageRow, QuestionRow } from '../../types'
import type { QuestionInspectResult } from '../../../../../shared/orchestration-rpc-contract'
import { OrchestrationError } from '../../orchestration-error'
import { exposeQuestionTimestamps } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'
import { getActiveDispatchForTask } from '../dispatch-context/task-dispatch-reconciliation'

export function createQuestion(
  this: OrchestrationDb,
  params: {
    runId: string
    dispatchId: string
    askerHandle: string
    question: string
    options?: string[]
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
      to: `run:${params.runId}`,
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

export function inspectQuestion(
  this: OrchestrationDb,
  params: { messageId: string; runId: string; taskId: string; dispatchId: string }
): QuestionInspectResult['question'] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selected columns match the stored question and joined identity fields.
  const row = this.db
    .prepare(
      `SELECT question.*, dispatch.task_id, dispatch.run_id AS dispatch_run_id,
              task.run_id AS task_run_id, message.body, message.payload
       FROM question_threads question
       JOIN dispatch_contexts dispatch ON dispatch.id = question.dispatch_id
       JOIN tasks task ON task.id = dispatch.task_id
       JOIN messages message ON message.id = question.message_id
       WHERE question.message_id = ?`
    )
    .get(params.messageId) as
    | (QuestionRow & {
        task_id: string
        dispatch_run_id: string
        task_run_id: string
        body: string
        payload: string | null
      })
    | undefined
  if (!row) {
    throw new OrchestrationError(
      'question_not_found',
      `Question ${params.messageId} was not found.`
    )
  }
  if (
    row.run_id !== params.runId ||
    row.dispatch_run_id !== params.runId ||
    row.task_run_id !== params.runId ||
    row.task_id !== params.taskId ||
    row.dispatch_id !== params.dispatchId
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Question ${params.messageId} does not match the requested Run, Task and Dispatch.`
    )
  }
  const { dispatch_run_id: _dispatchRunId, task_run_id: _taskRunId, payload, ...question } = row
  const parsed: unknown = JSON.parse(payload ?? '{}')
  const options = parsed && typeof parsed === 'object' && 'options' in parsed ? parsed.options : []
  if (
    !Array.isArray(options) ||
    !options.every((option): option is string => typeof option === 'string')
  ) {
    throw new OrchestrationError(
      'request_mismatch',
      `Question ${params.messageId} has invalid stored options.`
    )
  }
  return { ...exposeQuestionTimestamps(question), task_id: row.task_id, body: row.body, options }
}

export type QuestionAnswerResult = {
  question: QuestionRow
  message: MessageRow
  duplicate: boolean
}

export function answerQuestion(
  this: OrchestrationDb,
  params: {
    messageId: string
    runId: string
    consumerGeneration: number
    body: string
    expectedIdentity?: { taskId: string; dispatchId: string }
    recordReceipt?: (answer: QuestionAnswerResult) => void
  }
): QuestionAnswerResult {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.requireCurrentConsumer(params.runId, params.consumerGeneration)
    if (params.expectedIdentity) {
      this.inspectQuestion({
        messageId: params.messageId,
        runId: params.runId,
        ...params.expectedIdentity
      })
    }
    const question = this.getQuestionRaw(params.messageId)
    if (!question || question.run_id !== params.runId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${params.messageId} was not found in Run ${params.runId}.`
      )
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
      const result = { question: exposeQuestionTimestamps(question), message, duplicate: true }
      params.recordReceipt?.(result)
      this.db.exec('COMMIT')
      return result
    }
    const dispatch = this.getDispatchContextById(question.dispatch_id)
    const task = dispatch ? this.getTask(dispatch.task_id) : undefined
    if (
      !dispatch ||
      dispatch.run_id !== params.runId ||
      (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') ||
      !task ||
      task.run_id !== params.runId ||
      (task.status !== 'dispatched' && task.status !== 'blocked') ||
      getActiveDispatchForTask(this, task.id)?.id !== dispatch.id
    ) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${params.messageId} no longer belongs to the active Task Dispatch.`
      )
    }

    const message = this.insertMessage({
      from: `run:${params.runId}`,
      to: `dispatch:${question.dispatch_id}`,
      subject: 'Re: Question',
      body: params.body,
      threadId: question.message_id,
      runId: params.runId
    })
    // Why: ask returns thread state directly; leaving its answer unread would deliver it again via check.
    this.markAsRead([message.id])
    this.db
      .prepare(
        `UPDATE question_threads
         SET status = 'answered', answer_message_id = ?, answer_body = ?,
             answered_by_generation = ?, answered_at = datetime('now')
         WHERE message_id = ? AND status = 'pending'`
      )
      .run(message.id, params.body, params.consumerGeneration, question.message_id)
    if (this.getFederatedDispatch(question.dispatch_id)) {
      this.enqueueFederationRelay({
        dispatchId: question.dispatch_id,
        direction: 'to_worker',
        kind: 'reply',
        payload: JSON.stringify({
          questionId: question.message_id,
          answerMessageId: message.id,
          body: params.body
        })
      })
    }
    const answered = this.getQuestionRaw(question.message_id) as QuestionRow
    const storedMessage = this.getMessageById(message.id) as MessageRow
    const result = {
      question: exposeQuestionTimestamps(answered),
      message: storedMessage,
      duplicate: false
    }
    params.recordReceipt?.(result)
    this.db.exec('COMMIT')
    return result
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function closeQuestionsForDispatch(this: OrchestrationDb, dispatchId: string): string[] {
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
  inspectQuestion: typeof inspectQuestion
  answerQuestion: typeof answerQuestion
  closeQuestionsForDispatch: typeof closeQuestionsForDispatch
}

export function attachQuestionThreads(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createQuestion,
    getQuestion,
    getQuestionRaw,
    inspectQuestion,
    answerQuestion,
    closeQuestionsForDispatch
  })
}
