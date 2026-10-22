import { defineMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration-rpc-contract'
import { resolveRunScope } from '../runs/run-scope'
import {
  readMutationReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-receipt'
import { exposeMessage } from './mailbox-message-receipt'
import {
  recordReceiptBeforeNudge,
  recordReceiptForPostCommitNudge,
  replayMutationNudge
} from './mutation-replay-nudge'
import { resolveReplyRecipient } from './recipient-routing'
import {
  MessageReplyParams,
  QuestionInspectParams,
  QuestionReplyParams,
  ReplyParams
} from '../schemas'

const questionInspectMethod = defineMethod({
  name: 'orchestration.questionInspect',
  permission: 'workspace',
  params: QuestionInspectParams,
  handler: (params, { runtime, legacyCoordinatorRunId }) => {
    if (legacyCoordinatorRunId && params.run !== legacyCoordinatorRunId) {
      throw new OrchestrationError('request_mismatch', 'Question belongs to another Run.', {
        effectsApplied: false
      })
    }
    return {
      question: runtime.getOrchestrationDb().inspectQuestion({
        messageId: params.id,
        runId: params.run,
        taskId: params.task,
        dispatchId: params.dispatch
      })
    }
  }
})

const replyMethod = defineMethod({
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
      replayedMutationReceipt
    }
  ) => {
    const replayNudge = readMutationReplayNudge(replayedMutationReceipt)
    if (replayNudge) {
      replayMutationNudge(runtime, replayNudge)
      return stripMutationReplayNudge(replayedMutationReceipt)
    }
    const db = runtime.getOrchestrationDb()
    const question = db.getQuestion(params.id)
    if (params.mode === 'question' && !question) {
      throw new OrchestrationError('question_not_found', `Question ${params.id} was not found.`, {
        effectsApplied: false
      })
    }
    if (params.mode === 'message' && question) {
      throw new OrchestrationError(
        'request_mismatch',
        'Question threads require the question reply selector.',
        { effectsApplied: false }
      )
    }
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
    if (question) {
      const run = resolveRunScope(runtime, {
        runId: params.run ?? question.run_id,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const expectedIdentity =
        params.mode === 'question' && params.task && params.dispatch
          ? { taskId: params.task, dispatchId: params.dispatch }
          : undefined
      const federated = db.getFederatedDispatch(question.dispatch_id)
      const completion: { committed?: { receipt: unknown; nudge: () => void } } = {}
      db.answerQuestion({
        messageId: params.id,
        runId: run.id,
        consumerGeneration: run.consumer_generation,
        body: params.body,
        expectedIdentity,
        recordReceipt: (answer) => {
          const receipt = {
            message: exposeMessage(answer.message),
            question: answer.question,
            duplicate: answer.duplicate
          }
          completion.committed = federated
            ? recordReceiptForPostCommitNudge(
                recordMutationReceipt,
                receipt,
                () => runtime.ensureOrchestrationFederationRelay(run.id),
                { kind: 'federation', runId: run.id }
              )
            : recordReceiptForPostCommitNudge(recordMutationReceipt, receipt, () =>
                runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
              )
        }
      })
      const committed = completion.committed
      if (!committed) {
        throw new Error('Question answer committed without its receipt.')
      }
      committed.nudge()
      return committed.receipt
    }
    const recipient = resolveReplyRecipient({
      runtime,
      db,
      originalFrom: original.from_handle,
      originalRunId: original.run_id
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
    return recordReceiptBeforeNudge(recordMutationReceipt, { message: exposeMessage(reply) }, () =>
      runtime.notifyMessageArrived(reply.to_handle, reply.type)
    )
  }
})

export const ORCHESTRATION_REPLY_METHODS = [
  questionInspectMethod,
  replyMethod,
  defineMethod({
    name: 'orchestration.messageReply',
    permission: 'workspace',
    params: MessageReplyParams,
    handler: (params, ctx) => replyMethod.handler({ ...params, mode: 'message' }, ctx)
  }),
  defineMethod({
    name: 'orchestration.questionReply',
    permission: 'workspace',
    params: QuestionReplyParams,
    handler: (params, ctx) => replyMethod.handler({ ...params, mode: 'question' }, ctx)
  })
]
