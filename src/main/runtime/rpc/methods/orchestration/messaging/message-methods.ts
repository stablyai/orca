import { ORCHESTRATION_REPLY_METHOD } from './reply-method'
import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { inspectedRunAccess, taskCreateAccess, taskUpdateAccess } from '../access/run-access-rules'
import type { TaskStatus } from '../../../../orchestration/db/orchestration-records'
import { exposeUtcTimestamp } from '../../../../orchestration/db/utc-timestamp'
import { abbreviateOrchestrationTasks } from '../../../../../../shared/orchestration/orchestration-task-summary'
import { orchestrationCallerIdentity } from '../runs/run-scope'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { resolveOrchestrationParty } from '../../../../orchestration/addressing/orchestration-party'
import {
  InboxParams,
  TaskCreateParams,
  TaskListParams
} from '../../../../../../shared/rpc-contract/orchestration/orchestration-params'
import { TaskUpdateParams } from './task-update-params'

export const ORCHESTRATION_MESSAGE_METHODS = [
  ORCHESTRATION_REPLY_METHOD,
  defineOrchestrationMethod({
    name: 'orchestration.inbox',
    permission: 'workspace',
    params: InboxParams,
    access: { kind: 'reads', targets: { terminal: 'party', run: 'run' }, collection: true },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: an empty list for a mistyped Run (or a `run:` mailbox address) reads as "no mail".
      if (params.run && !db.getRun(params.run)) {
        const hint = params.run.startsWith('run:')
          ? ' --run takes the bare Run id; --terminal takes the run:<id> mailbox.'
          : ''
        throw new OrchestrationError('run_not_found', `Run ${params.run} was not found.${hint}`)
      }
      // Return empty for stale/unknown handles because historical mail outlives handle deletion (design doc §3.3).
      const messages = params.terminal
        ? db.getAllMessagesForHandle(
            resolveOrchestrationParty(params.terminal, db).address,
            params.limit,
            undefined,
            params.run
          )
        : db.getInbox(params.limit, params.run)
      return {
        messages: messages.map(
          ({ answer_sender_snapshot: _answer, reply_to: _replyTo, ...message }) => message
        ),
        count: messages.length
      }
    }
  }),

  defineOrchestrationMethod({
    name: 'orchestration.taskCreate',
    permission: 'workspace',
    params: TaskCreateParams,
    access: {
      kind: 'writes',
      caller: 'callerTerminalHandle',
      targets: { run: 'run', parent: 'task', deps: 'task' },
      rule: taskCreateAccess
    },
    handler: (params, { orchestrationCaller, runtime }, { run, deps }) => {
      const db = runtime.getOrchestrationDb()
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

  defineOrchestrationMethod({
    name: 'orchestration.taskList',
    permission: 'workspace',
    params: TaskListParams,
    access: {
      kind: 'reads',
      caller: 'callerTerminalHandle',
      targets: { run: 'run' },
      collection: true,
      rule: inspectedRunAccess
    },
    handler: (params, { runtime }, { run }) => {
      const db = runtime.getOrchestrationDb()
      // Add nullable assignee_handle/dispatch_id without changing legacy non-dispatched rows.
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

  defineOrchestrationMethod({
    name: 'orchestration.taskUpdate',
    permission: 'workspace',
    params: TaskUpdateParams,
    access: {
      kind: 'writes',
      caller: 'callerTerminalHandle',
      callerPane: 'senderPaneKey',
      targets: { id: 'task', run: 'run' },
      rule: taskUpdateAccess
    },
    handler: (params, { runtime, recordMutationReceipt }, grant) => {
      const db = runtime.getOrchestrationDb()
      if (grant.kind === 'note') {
        const updated = db.recordWorkerProgress({
          dispatchId: grant.dispatch.id,
          note: params.note!
        })
        const task = db.getTask(updated.task_id)
        if (!task) {
          throw new Error(`Task not found: ${updated.task_id}`)
        }
        const receipt = {
          task,
          dispatchId: updated.id,
          progressNote: updated.progress_note ?? params.note!,
          progressUpdatedAt:
            exposeUtcTimestamp(updated.progress_updated_at) ??
            updated.progress_updated_at ??
            undefined
        }
        recordMutationReceipt?.(receipt)
        return receipt
      }
      const task = db.updateTaskStatus(params.id!, params.status!, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  })
]
