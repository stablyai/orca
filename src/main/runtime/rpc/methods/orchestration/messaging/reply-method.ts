import { acceptedAnswerSender } from '../../../../orchestration/mailbox/senders/accepted-answer-sender'
import { answerSenderRelayReport } from '../../../../orchestration/mailbox/senders/answer-sender-relay-report'
import { defineMethod } from '../../../core'
import { deliverQuestionAnswer } from '../../../../orchestration/mailbox/questions/question-answer-delivery'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration/orchestration-rpc-contract'
import { orchestrationCallerIdentity, resolveRunScope } from '../runs/run-scope'
import { assertSessionLinkMailBoundary } from '../../../../orchestration/session-links/session-link-mail-boundary'
import {
  readMutationReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-receipt'
import { exposeMessage } from './mailbox-message-receipt'
import { recordReceiptBeforeNudge, replayMutationNudge } from './mutation-replay-nudge'
import { resolveReplyRecipient } from './recipient-routing'
import { helperQuestionAnswerer } from './helper-question-answerer'
import { replyToRemoteRunHome } from './reply-remote'
import { withAnswerNext } from '../receipt-next'
import { ReplyParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import {
  completionReportDispatchId,
  reportFollowUpAction
} from '../../../../orchestration/workers/reports/report-follow-up-action'
import { formatFinishedReportReplyRefusal } from '../../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'

export const ORCHESTRATION_REPLY_METHOD = defineMethod({
  name: 'orchestration.reply',
  permission: 'workspace',
  params: ReplyParams,
  handler: async (
    params,
    {
      orchestrationCompatibilityEvidence,
      orchestrationCaller,
      runtime,
      legacyCoordinatorRunId,
      recordMutationReceipt,
      replayedMutationReceipt,
      signal
    }
  ) => {
    const replayNudge = readMutationReplayNudge(replayedMutationReceipt)
    if (replayNudge) {
      replayMutationNudge(runtime, replayNudge)
      return stripMutationReplayNudge(replayedMutationReceipt)
    }
    const db = runtime.getOrchestrationDb()
    const original = db.getMessageById(params.id)
    if (!original) {
      throw new Error(`Message not found: ${params.id}`)
    }
    if (
      legacyCoordinatorRunId &&
      (original.run_id !== legacyCoordinatorRunId ||
        (params.run !== undefined && params.run !== legacyCoordinatorRunId))
    ) {
      throw new OrchestrationError(
        'request_mismatch',
        `Message ${params.id} does not belong to this adopted Run.`,
        { effectsApplied: false }
      )
    }
    if (
      original.run_id === ORCHESTRATION_LEGACY_RUN_ID ||
      original.delivery_contract === 'legacy_direct' ||
      original.delivery_contract === 'audit_only'
    ) {
      throw new OrchestrationError(
        'legacy_read_only',
        'Legacy orchestration messages are inspect-only; no reply was applied.',
        { effectsApplied: false }
      )
    }

    assertSessionLinkMailBoundary(db, orchestrationCaller?.orcaSessionId, original.from_handle)
    const question = db.getQuestion(params.id)
    const creatorAnswerer =
      question && (params.run === undefined || params.run === question.run_id)
        ? helperQuestionAnswerer(runtime, {
            question: original,
            from: params.from,
            session: orchestrationCaller,
            evidence: orchestrationCompatibilityEvidence
          })
        : undefined
    if (question && creatorAnswerer) {
      const answered = db.answerQuestion({
        messageId: question.message_id,
        runId: question.run_id,
        answeredBy: creatorAnswerer,
        captureSender: acceptedAnswerSender(
          runtime,
          `dispatch:${creatorAnswerer.dispatchId}`,
          orchestrationCallerIdentity(runtime, {
            handle: params.from ?? '',
            session: orchestrationCaller,
            paneKey: orchestrationCaller ? undefined : runtime.getTerminalPaneKey(params.from ?? '')
          })
        ),
        body: params.body
      })
      return recordReceiptBeforeNudge(
        recordMutationReceipt,
        { ...answered, message: exposeMessage(answered.message) },
        () => deliverQuestionAnswer(runtime, question)
      )
    }
    if (question) {
      const run = resolveRunScope(runtime, {
        runId: params.run ?? question.run_id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const answered = db.answerQuestion({
        messageId: question.message_id,
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        captureSender: acceptedAnswerSender(
          runtime,
          `run:${run.id}`,
          orchestrationCallerIdentity(runtime, {
            handle: params.from ?? '',
            session: orchestrationCaller,
            paneKey: orchestrationCaller ? undefined : runtime.getTerminalPaneKey(params.from ?? '')
          })
        ),
        body: params.body
      })
      const federated = db.getFederatedDispatch(question.dispatch_id)
      const receipt = withAnswerNext({
        message: exposeMessage(answered.message),
        question: answered.question,
        duplicate: answered.duplicate
      })
      if (federated) {
        db.enqueueFederationRelay({
          dispatchId: question.dispatch_id,
          direction: 'to_worker',
          kind: 'reply',
          answerSenderReport: answerSenderRelayReport(answered.message.answer_sender_snapshot),
          payload: JSON.stringify({
            questionId: question.message_id,
            answerMessageId: answered.message.id,
            body: params.body
          })
        })
        return recordReceiptBeforeNudge(
          recordMutationReceipt,
          receipt,
          () => runtime.ensureOrchestrationFederationRelay(run.id),
          { kind: 'federation', runId: run.id }
        )
      }
      return recordReceiptBeforeNudge(recordMutationReceipt, receipt, () =>
        deliverQuestionAnswer(runtime, question)
      )
    }

    if (db.getRun(original.run_id)?.home_database === 'remote') {
      return await replyToRemoteRunHome({ runtime, db, original, params, signal })
    }
    // A finished task's worker never reads a reply to its report; refuse before marking or storing anything.
    const reportDispatchId = completionReportDispatchId(db, original)
    const followUp = reportDispatchId ? reportFollowUpAction(db, reportDispatchId) : undefined
    if (reportDispatchId && followUp) {
      throw new OrchestrationError(
        'dispatch_inactive',
        formatFinishedReportReplyRefusal(reportDispatchId, followUp),
        { effectsApplied: false, followUp }
      )
    }
    const recipient = resolveReplyRecipient({
      runtime,
      db,
      originalFrom: original.from_handle,
      originalRunId: original.run_id
    })
    assertSessionLinkMailBoundary(db, orchestrationCaller?.orcaSessionId, recipient.to)
    db.markAsRead([original.id])
    const reply = db.insertMessage({
      from: params.from ?? original.to_handle,
      to: recipient.to,
      subject: `Re: ${original.subject}`,
      body: params.body,
      threadId: original.thread_id ?? original.id,
      runId: recipient.runId
    })

    const receipt = {
      message: exposeMessage(reply),
      ...(recipient.warning ? { warnings: [recipient.warning] } : {})
    }
    return recordReceiptBeforeNudge(recordMutationReceipt, receipt, () =>
      runtime.notifyMessageArrived(reply.to_handle, reply.type)
    )
  }
})
