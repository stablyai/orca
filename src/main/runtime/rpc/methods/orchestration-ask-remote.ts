import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../shared/orchestration-ask-timeout'
import type { AskParams } from './orchestration-schemas'

export async function askRemoteRunHome(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  signal?: AbortSignal
  orchestrationCapability?: string
  recordMutationReceipt?: (receipt: unknown) => void
  from: string
  paneKey: string
  dispatchId: string
  taskId: string
}): Promise<unknown> {
  const db = args.runtime.getOrchestrationDb()
  const timeoutMs = clampOrchestrationAskTimeoutMs(args.params.timeoutMs)
  if (
    !db.verifyRemoteAttachmentAuthority({
      dispatchId: args.dispatchId,
      capability: args.orchestrationCapability,
      paneKey: args.paneKey,
      processIncarnation: args.runtime.getTerminalProcessIncarnation(args.from)
    })
  ) {
    throw new OrchestrationError(
      'dispatch_capability_invalid',
      'The remote Dispatch capability or exact worker process is invalid.'
    )
  }
  const options =
    args.params.options
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  let questionId = args.params.resume
  if (questionId) {
    const existing = db.getRemoteQuestion(questionId)
    if (!existing || existing.dispatch_id !== args.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${questionId} does not belong to this remote Dispatch.`
      )
    }
  } else {
    const relay = db.enqueueFederationRelay({
      dispatchId: args.dispatchId,
      direction: 'to_home',
      kind: 'question',
      payload: JSON.stringify({
        from: args.from,
        subject: 'Question',
        body: args.params.question as string,
        type: 'question',
        priority: 'normal',
        threadId: null,
        payload: JSON.stringify({
          taskId: args.taskId,
          dispatchId: args.dispatchId,
          question: args.params.question,
          options
        })
      }),
      remoteQuestion: true
    })
    questionId = relay.message_id
  }
  args.recordMutationReceipt?.({
    accepted: true,
    answer: null,
    messageId: questionId,
    threadId: questionId,
    timedOut: false,
    cancelled: false,
    connectionLost: false,
    timeoutMs
  })
  const deadline = Date.now() + timeoutMs
  while (true) {
    const question = db.getRemoteQuestion(questionId)
    if (!question || question.status === 'closed') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${questionId} closed because its remote Dispatch is inactive.`
      )
    }
    if (question.status === 'answered') {
      return {
        answer: question.answer_body,
        messageId: questionId,
        answerMessageId: question.answer_message_id,
        threadId: questionId,
        timedOut: false,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    if (args.signal?.aborted) {
      return {
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: false,
        cancelled: true,
        connectionLost: true,
        timeoutMs
      }
    }
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      return {
        answer: null,
        messageId: questionId,
        threadId: questionId,
        timedOut: true,
        cancelled: false,
        connectionLost: false,
        timeoutMs
      }
    }
    await args.runtime.waitForMessage(`dispatch:${args.dispatchId}`, {
      timeoutMs: remainingMs,
      signal: args.signal
    })
  }
}
