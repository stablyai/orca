import type { OrcaRuntimeService } from '../../../orca-runtime'
import { OrchestrationError } from '../../orchestration-error'

type QuestionState = {
  message_id: string
  dispatch_id: string
  status: 'pending' | 'answered' | 'closed'
  answer_body: string | null
  answer_message_id: string | null
  told?: 'unanswered' | 'dropped' | null
}

/** Every waiting ask on a Dispatch's questions, which a Dispatch notification wakes to recheck closure. */
export function questionAnswerWaitPrefix(dispatchId: string): string {
  return `question:${dispatchId}:`
}

/** A waiting ask listens on its question, not its Dispatch mailbox, so other mail still wakes the worker. */
function questionAnswerWaitHandle(question: { dispatch_id: string; message_id: string }): string {
  return `${questionAnswerWaitPrefix(question.dispatch_id)}${question.message_id}`
}

/** A waiting ask takes its own answer; otherwise the answer is Dispatch mail that wakes the worker. */
export function deliverQuestionAnswer(
  runtime: Pick<OrcaRuntimeService, 'notifyMessageWaiters' | 'notifyMessageArrived'>,
  question: { message_id: string; dispatch_id: string }
): void {
  if (!runtime.notifyMessageWaiters(questionAnswerWaitHandle(question))) {
    runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
  }
}

const ASKED_QUESTION_NEXT = 'End your turn; Orca wakes you with the answer.'

/** The question is recorded and stays pending; its answer arrives as Dispatch mail. */
export function askedQuestionReceipt(
  questionId: string,
  recordMutationReceipt: ((receipt: unknown) => void) | undefined
): unknown {
  const receipt = {
    answer: null,
    messageId: questionId,
    threadId: questionId,
    pending: true,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    next: ASKED_QUESTION_NEXT
  }
  recordMutationReceipt?.(receipt)
  return receipt
}

/** The older waiting form of ask, kept for callers that still wait (older CLIs, --wait, --resume). */
export async function waitForQuestionAnswer(args: {
  runtime: Pick<
    OrcaRuntimeService,
    'waitForMessage' | 'getOrchestrationDb' | 'notifyMessageArrived'
  >
  questionId: string
  readQuestion: () => QuestionState | undefined
  closedMessage: string
  timeoutMs: number
  signal?: AbortSignal
  recordMutationReceipt?: (receipt: unknown) => void
  /** Re-proves a restart-recovered asker before each take; false leaves the answer for its worker. */
  callerCurrent?: () => boolean
}): Promise<unknown> {
  const { questionId, timeoutMs } = args
  const unanswered = { answer: null, messageId: questionId, threadId: questionId, timeoutMs }
  args.recordMutationReceipt?.({
    ...unanswered,
    accepted: true,
    timedOut: false,
    cancelled: false,
    connectionLost: false
  })
  const deadline = Date.now() + timeoutMs
  while (true) {
    const current = args.readQuestion()
    // A departed or replaced caller must not take the answer: leave it unread and wake the worker with it.
    const wakeWorker = (): void => {
      if (current?.status === 'answered' || (current && unreadNotice(args.runtime, current))) {
        args.runtime.notifyMessageArrived(`dispatch:${current.dispatch_id}`, 'status')
      }
    }
    if (args.signal?.aborted) {
      wakeWorker()
      return { ...unanswered, timedOut: false, cancelled: true, connectionLost: true }
    }
    if (!current || current.status === 'closed') {
      throw new OrchestrationError('dispatch_inactive', args.closedMessage)
    }
    if (args.callerCurrent && !args.callerCurrent()) {
      wakeWorker()
      throw new OrchestrationError(
        'consumer_fenced',
        `This asker no longer holds the Dispatch of question ${questionId}; its answer stays unread for its worker.`
      )
    }
    if (current.status === 'answered') {
      // This caller shows the answer, so its Dispatch mail must not deliver it again.
      if (current.answer_message_id) {
        args.runtime
          .getOrchestrationDb()
          .markAsReadAndDelivered([current.answer_message_id], { kind: 'orca' })
      }
      return {
        answer: current.answer_body,
        messageId: questionId,
        answerMessageId: current.answer_message_id,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    // Told and not yet seen: this wait returns the notice. Once seen, a resumed wait keeps waiting
    // for a late answer.
    const notice = current.told ? unreadNotice(args.runtime, current) : undefined
    if (current.told && notice) {
      args.runtime.getOrchestrationDb().markAsReadAndDelivered([notice.id], { kind: 'orca' })
      return {
        ...unanswered,
        notice: notice.body,
        told: current.told,
        timedOut: false,
        cancelled: false,
        connectionLost: false
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return { ...unanswered, timedOut: true, cancelled: false, connectionLost: false }
    }
    await args.runtime.waitForMessage(questionAnswerWaitHandle(current), {
      timeoutMs: remainingMs,
      signal: args.signal
    })
  }
}

/** The unread notice telling this question's worker it went unanswered. */
function unreadNotice(
  runtime: Pick<OrcaRuntimeService, 'getOrchestrationDb'>,
  question: QuestionState
): { id: string; body: string } | undefined {
  const row = runtime
    .getOrchestrationDb()
    .db.prepare(
      `SELECT id, body FROM messages WHERE thread_id = ? AND to_handle = ? AND id <> ? AND read = 0
       ORDER BY sequence DESC LIMIT 1`
    )
    .get(question.message_id, `dispatch:${question.dispatch_id}`, question.message_id)
  return typeof row?.id === 'string' && typeof row.body === 'string'
    ? { id: row.id, body: row.body }
    : undefined
}
