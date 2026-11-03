import type { z } from 'zod'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerDispatchState } from '../../../../orchestration/types'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { clampOrchestrationAskTimeoutMs } from '../../../../../../shared/orchestration-ask-timeout'
import type { AskParams } from '../schemas'
import { assertWorkerCanReport } from '../../../../orchestration/worker-report-admission'
import {
  askedQuestionReceipt,
  waitForQuestionAnswer
} from '../../../../orchestration/question-answer-delivery'

export async function askRemoteRunHome(args: {
  params: z.infer<typeof AskParams>
  runtime: OrcaRuntimeService
  signal?: AbortSignal
  recordMutationReceipt?: (receipt: unknown) => void
  from: string
  paneKey: string
  dispatchId: string
  taskId: string
  workerState: WorkerDispatchState
}): Promise<unknown> {
  const db = args.runtime.getOrchestrationDb()
  const timeoutMs = clampOrchestrationAskTimeoutMs(args.params.timeoutMs)
  assertWorkerCanReport({
    dispatchId: args.dispatchId,
    from: args.from,
    workerState: args.workerState,
    processCurrent: db.isRemoteAttachmentProcessCurrent({
      dispatchId: args.dispatchId,
      paneKey: args.paneKey,
      processIncarnation: args.runtime.getTerminalProcessIncarnation(args.from)
    })
  })
  const options =
    args.params.options
      ?.split(',')
      .map((option) => option.trim())
      .filter(Boolean) ?? []
  const resume = args.params.resume
  if (resume) {
    const existing = db.getRemoteQuestion(resume)
    if (!existing || existing.dispatch_id !== args.dispatchId) {
      throw new OrchestrationError(
        'question_not_found',
        `Question ${resume} does not belong to this remote Dispatch.`
      )
    }
  }
  const questionId =
    resume ??
    db.enqueueFederationRelay({
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
    }).message_id
  if (!resume && args.params.wait === false) {
    return askedQuestionReceipt(questionId, args.recordMutationReceipt)
  }
  return waitForQuestionAnswer({
    runtime: args.runtime,
    questionId,
    readQuestion: () => db.getRemoteQuestion(questionId),
    closedMessage: `Question ${questionId} closed because its remote Dispatch is inactive.`,
    timeoutMs,
    signal: args.signal,
    recordMutationReceipt: args.recordMutationReceipt
  })
}
