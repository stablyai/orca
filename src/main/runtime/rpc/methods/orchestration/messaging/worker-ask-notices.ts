/** A worker's `ask` its coordinator stopped without answering, or that no one will read: the
 *  worker is told on the route an answer takes, so its stop reporting resumes. */

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { QuestionNoticeWriter } from '../../../../orchestration/mailbox/questions/question-reconcile'
import { encodeFederatedControlMessage } from '../../../../orchestration/legacy-remote/federation-control-message'
import { deliverQuestionAnswer } from '../../../../orchestration/mailbox/questions/question-answer-delivery'
import { ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'

export function workerAskNoticeText(runId: string, why: string): string {
  if (why === 'withdrawn') {
    return 'Your question was removed before your coordinator read it. Decide it yourself and say what you chose when you report.'
  }
  return why === 'no-reader'
    ? `No one coordinates Run ${runId} now, so no one will read your question. Decide it yourself and say what you chose when you report.`
    : 'Your coordinator stopped without answering your question and has no worker running for it. Decide it yourself and say what you chose when you report. If an answer comes later, it still reaches you.'
}

export function workerAskNotices(
  runtime: Pick<
    OrcaRuntimeService,
    | 'getOrchestrationDb'
    | 'notifyMessageArrived'
    | 'notifyMessageWaiters'
    | 'ensureOrchestrationFederationRelay'
  >,
  taker: string
): QuestionNoticeWriter {
  const db = runtime.getOrchestrationDb()
  const dropped = taker.startsWith('dropped:') ? taker.slice('dropped:'.length) : null
  return ({ messageId }) => {
    const question = db.getQuestionRaw(messageId)
    if (question?.status !== 'pending' || question.told !== null) {
      return 'told'
    }
    db.db
      .prepare('UPDATE question_threads SET told = ? WHERE message_id = ?')
      .run(dropped === null ? 'unanswered' : 'dropped', messageId)
    const body = workerAskNoticeText(question.run_id, dropped ?? 'unanswered')
    const notice = {
      from: `run:${question.run_id}`,
      subject: 'Re: Question',
      body,
      threadId: messageId
    }
    const federated = db.getFederatedDispatch(question.dispatch_id)
    if (federated) {
      // As coordinator mail to a paired worker goes; a worker too old to take it isn't told.
      if (federated.protocol_version >= ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION) {
        db.enqueueFederationRelay({
          dispatchId: question.dispatch_id,
          direction: 'to_worker',
          kind: 'control_message',
          payload: encodeFederatedControlMessage({
            ...notice,
            type: 'status',
            priority: 'normal',
            payload: null
          })
        })
        queueMicrotask(() => runtime.ensureOrchestrationFederationRelay(question.run_id))
      }
      return 'told'
    }
    db.insertMessage({
      ...notice,
      replyTo: messageId,
      to: `dispatch:${question.dispatch_id}`,
      runId: question.run_id
    })
    // After the write commits: a waiting `ask` takes it, else it's mail that wakes the worker.
    queueMicrotask(() => deliverQuestionAnswer(runtime, question))
    return 'told'
  }
}
