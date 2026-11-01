import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationError } from './orchestration-error'

type QuestionState = {
  message_id: string
  dispatch_id: string
  status: 'pending' | 'answered' | 'closed'
  answer_body: string | null
  answer_message_id: string | null
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
    if (args.signal?.aborted) {
      // A departed caller must not take the answer: leave it unread and wake the worker with it.
      if (current?.status === 'answered') {
        args.runtime.notifyMessageArrived(`dispatch:${current.dispatch_id}`, 'status')
      }
      return { ...unanswered, timedOut: false, cancelled: true, connectionLost: true }
    }
    if (!current || current.status === 'closed') {
      throw new OrchestrationError('dispatch_inactive', args.closedMessage)
    }
    if (current.status === 'answered') {
      // This caller shows the answer, so its Dispatch mail must not deliver it again.
      if (current.answer_message_id) {
        args.runtime.getOrchestrationDb().markAsReadAndDelivered([current.answer_message_id])
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
