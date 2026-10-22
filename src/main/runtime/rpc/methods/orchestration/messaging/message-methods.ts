import { defineMethod } from '../../../core'
import type { TaskStatus } from '../../../../orchestration/db'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { abbreviateOrchestrationTasks } from '../../../../../../shared/orchestration-task-summary'
import { parseOrchestrationTaskDepsFlag } from '../../../../orchestration/task-deps-flag'
import { orchestrationCallerIdentity, resolveRunScope } from '../runs/run-scope'
import { resolveOrchestrationParty } from '../../../../orchestration/orchestration-party'
import { InboxParams, TaskCreateParams, TaskListParams, TaskUpdateParams } from '../schemas'
import { ORCHESTRATION_REPLY_METHODS } from './reply-methods'

export const ORCHESTRATION_MESSAGE_METHODS = [
  ...ORCHESTRATION_REPLY_METHODS,

  defineMethod({
    name: 'orchestration.inbox',
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
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
    permission: 'workspace',
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
