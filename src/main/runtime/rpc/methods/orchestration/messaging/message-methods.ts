import { defineMethod } from '../../../core'
import type { TaskStatus } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { ORCHESTRATION_LEGACY_RUN_ID } from '../../../../../../shared/orchestration-rpc-contract'
import { abbreviateOrchestrationTasks } from '../../../../../../shared/orchestration-task-summary'
import { parseOrchestrationTaskDepsFlag } from '../../../../orchestration/task-deps-flag'
import { orchestrationCallerIdentity, resolveRunScope } from '../runs/run-scope'
import {
  readMutationReplayNudge,
  stripMutationReplayNudge
} from '../../../orchestration-mutation-executor'
import { exposeMessage } from './mailbox-message-receipt'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { recordReceiptBeforeNudge, replayMutationNudge } from './mutation-replay-nudge'
import { resolveReplyRecipient } from './recipient-routing'
import {
  ReplyParams,
  InboxParams,
  TaskCreateParams,
  TaskListParams,
  TaskUpdateParams
} from '../schemas'

export const ORCHESTRATION_MESSAGE_METHODS = [
  defineMethod({
    name: 'orchestration.reply',
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

      const question = db.getQuestion(params.id)
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
          body: params.body
        })
        const federated = db.getFederatedDispatch(question.dispatch_id)
        const receipt = {
          message: exposeMessage(answered.message),
          question: answered.question,
          duplicate: answered.duplicate
        }
        if (federated) {
          db.enqueueFederationRelay({
            dispatchId: question.dispatch_id,
            direction: 'to_worker',
            kind: 'reply',
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
          runtime.notifyMessageArrived(`dispatch:${question.dispatch_id}`, 'status')
        )
      }

      db.markAsRead([original.id])

      const recipient = resolveReplyRecipient({
        runtime,
        db,
        originalFrom: original.from_handle,
        originalRunId: original.run_id
      })
      const reply = db.insertMessage({
        from: params.from ?? original.to_handle,
        to: recipient.to,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id,
        runId: recipient.runId
      })

      const receipt = { message: exposeMessage(reply) }
      return recordReceiptBeforeNudge(recordMutationReceipt, receipt, () =>
        runtime.notifyMessageArrived(reply.to_handle, reply.type)
      )
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: stale/unknown handles return empty rather than error — historical rows survive handle deletion (design doc §3.3).
      const messages = params.terminal
        ? db.getAllMessagesForHandle(
            resolveOrchestrationParty(params.terminal, db).address,
            params.limit
          )
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const deps = params.deps ? parseOrchestrationTaskDepsFlag(params.deps) : undefined
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      // A handle-less session creates root Tasks: Task lineage is recorded by terminal only.
      const creatorHandle = params.callerTerminalHandle
        ? orchestrationCallerIdentity(runtime, {
            handle: params.callerTerminalHandle,
            session: orchestrationCaller,
            paneKey: null
          }).terminalHandle
        : null
      const creatorAuthority = creatorHandle
        ? runtime.getOrchestrationDispatchAuthority(creatorHandle)
        : null
      const task = db.createTask({
        spec: params.spec,
        taskTitle: params.taskTitle,
        displayName: params.displayName,
        deps,
        parentId: params.parent,
        createdByTerminalHandle: creatorHandle ?? undefined,
        ...(creatorAuthority?.paneKey && creatorAuthority.processIncarnation
          ? {
              createdByPaneKey: creatorAuthority.paneKey,
              createdByProcessIncarnation: creatorAuthority.processIncarnation,
              createdByRunGeneration: run.consumer_generation
            }
          : {}),
        runId: run.id
      })
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const explicitRun = params.run ? db.getRun(params.run) : undefined
      const run =
        explicitRun?.legacy === 1
          ? explicitRun
          : resolveRunScope(runtime, {
              runId: params.run,
              callerTerminalHandle: params.callerTerminalHandle,
              requireCurrentConsumer: params.run === undefined,
              legacyCoordinatorRunId,
              callerEvidence: orchestrationCompatibilityEvidence,
              callerSession: orchestrationCaller
            })
      // Why: listTasksWithDispatch adds assignee_handle + dispatch_id (NULL for non-dispatched), so legacy-shape consumers are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready,
        runId: run.id
      })
      const tasks = joined.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return {
        runId: run.id,
        legacyReadOnly: run.legacy === 1,
        tasks: params.brief ? abbreviateOrchestrationTasks(tasks) : tasks,
        count: tasks.length
      }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (
      params,
      { orchestrationCompatibilityEvidence, orchestrationCaller, runtime, legacyCoordinatorRunId }
    ) => {
      const db = runtime.getOrchestrationDb()
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.callerTerminalHandle,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence,
        callerSession: orchestrationCaller
      })
      const existing = db.getTask(params.id)
      if (!existing || existing.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.id} was not found in Run ${run.id}.`
        )
      }
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  })
]
