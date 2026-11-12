import { acceptedAnswerSender } from '../../../../orchestration/mailbox/senders/accepted-answer-sender'
import { resolveTerminalAgentRecipient } from './session-recipient'
import { answerSenderRelayReport } from '../../../../orchestration/mailbox/senders/answer-sender-relay-report'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { deliverQuestionAnswer } from '../../../../orchestration/mailbox/questions/question-answer-delivery'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import {
  readMutationReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-receipt'
import { exposeMessage } from './mailbox-message-receipt'
import { recordReceiptBeforeNudge, replayMutationNudge } from './mutation-replay-nudge'
import { resolveReplyRecipient } from './recipient-routing'
import { replyAccess } from './reply-access'
import { replyToRemoteRunHome } from '../../../../orchestration/legacy-remote/reply-remote'
import { replyOverPeerMail } from './peer-mail-reply'
import { withAnswerNext } from '../receipt-next'
import { ReplyParams } from '../../../../../../shared/rpc-contract/orchestration-params'
import {
  completionReportDispatchId,
  reportFollowUpAction
} from '../../../../orchestration/workers/reports/report-follow-up-action'
import { formatFinishedReportReplyRefusal } from '../../../../../../shared/orchestration/mailbox/orchestration-report-follow-up'

export const ORCHESTRATION_REPLY_METHOD = defineOrchestrationMethod({
  name: 'orchestration.reply',
  permission: 'workspace',
  params: ReplyParams,
  access: {
    kind: 'writes',
    caller: 'from',
    server: 'on',
    targets: { id: 'message', run: 'run' },
    rule: replyAccess
  },
  replay: (_params, { runtime, replayedMutationReceipt }) => {
    const nudge = readMutationReplayNudge(replayedMutationReceipt)
    if (!nudge) {
      return undefined
    }
    replayMutationNudge(runtime, nudge)
    return { receipt: stripMutationReplayNudge(replayedMutationReceipt) }
  },
  handler: async (
    params,
    { orchestrationCaller, runtime, recordMutationReceipt, orchestrationMutation, signal },
    access
  ) => {
    const db = runtime.getOrchestrationDb()
    const { original } = access
    if (access.kind === 'helper') {
      const { question, answerer } = access
      const answered = db.answerQuestion({
        messageId: question.message_id,
        runId: question.run_id,
        answeredBy: answerer,
        captureSender: acceptedAnswerSender(
          runtime,
          `dispatch:${answerer.dispatchId}`,
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
    if (access.kind === 'run') {
      const { question, run } = access
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

    const peerRoute = db.getPeerMailMessage(original.id)
    if (peerRoute) {
      return await replyOverPeerMail({
        runtime,
        original,
        route: peerRoute,
        params,
        orchestrationCaller,
        orchestrationMutation,
        recordMutationReceipt
      })
    }
    if (params.on !== undefined) {
      throw new OrchestrationError(
        'invalid_argument',
        `${params.id} did not come from another server, so its reply stays on this Orca. Drop --on. No reply was sent.`,
        { effectsApplied: false }
      )
    }
    if (db.getRun(original.run_id)?.home_database === 'remote') {
      return await replyToRemoteRunHome({ runtime, db, original, params, signal })
    }
    // Await first, so the refusals and routing below read state as it is after the wait.
    const terminalRecipient = await resolveTerminalAgentRecipient(original.from_handle)
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
      originalRunId: original.run_id,
      terminalRecipient
    })
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
