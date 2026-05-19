/* eslint-disable max-lines -- Why: RPC method definitions co-locate param schemas with handlers; splitting by method would scatter the shared enums and Zod transforms without reducing complexity. */
import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalFiniteNumber, OptionalString, OptionalBoolean, requiredString } from '../schemas'
import type { MessageType, MessagePriority, TaskStatus } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { formatMessageBanner } from '../../orchestration/formatter'
import { isGroupAddress, resolveGroupAddress } from '../../orchestration/groups'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'

const MESSAGE_TYPES: MessageType[] = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'heartbeat'
]

const TASK_STATUSES: TaskStatus[] = [
  'pending',
  'ready',
  'dispatched',
  'completed',
  'failed',
  'blocked'
]

const SendParams = z.object({
  to: requiredString('Missing --to'),
  subject: requiredString('Missing --subject'),
  from: OptionalString,
  body: OptionalString,
  type: z
    .enum([
      'status',
      'dispatch',
      'worker_done',
      'merge_ready',
      'escalation',
      'handoff',
      'decision_gate',
      'heartbeat'
    ])
    .optional(),
  priority: z.enum(['normal', 'high', 'urgent']).optional(),
  threadId: OptionalString,
  payload: OptionalString,
  devMode: OptionalBoolean
})

const CheckParams = z.object({
  terminal: OptionalString,
  unread: OptionalBoolean,
  // Why: `all` surfaces every message for the handle and skips mark-read.
  // Previously the only way to ask for "all" was the hidden RPC trick
  // `{unread: false}`. See design doc §3.2 / §3.3.
  all: OptionalBoolean,
  types: OptionalString,
  inject: OptionalBoolean,
  wait: OptionalBoolean,
  timeoutMs: OptionalFiniteNumber
})

const ReplyParams = z.object({
  id: requiredString('Missing --id'),
  body: requiredString('Missing --body'),
  from: OptionalString
})

const InboxParams = z.object({
  limit: OptionalFiniteNumber,
  // Why: filters the inbox listing to a specific handle so coordinators can
  // ask "everything for this handle" with either `inbox` or `check --all`
  // and get agreeing results. See design doc §3.3.
  terminal: OptionalString
})

const TaskCreateParams = z.object({
  spec: requiredString('Missing --spec'),
  deps: OptionalString,
  parent: OptionalString,
  callerTerminalHandle: OptionalString
})

const TaskListParams = z.object({
  status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']).optional(),
  ready: OptionalBoolean
})

const TaskUpdateParams = z.object({
  id: requiredString('Missing --id'),
  status: z
    .unknown()
    .transform((v) => {
      if (typeof v === 'string' && TASK_STATUSES.includes(v as TaskStatus)) {
        return v as TaskStatus
      }
      return ''
    })
    .pipe(
      z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'], {
        message: 'Missing --status'
      })
    ),
  result: OptionalString
})

const DispatchParams = z.object({
  task: requiredString('Missing --task'),
  // Why: --to is only required for real dispatches. When --dry-run is set the
  // caller is previewing the preamble and no terminal is targeted, so allow it
  // to be absent. The handler enforces presence before any side-effecting work.
  to: OptionalString,
  from: OptionalString,
  inject: OptionalBoolean,
  dryRun: OptionalBoolean,
  returnPreamble: OptionalBoolean,
  devMode: OptionalBoolean
})

const DispatchShowParams = z.object({
  task: OptionalString,
  preamble: OptionalBoolean,
  from: OptionalString,
  devMode: OptionalBoolean
})

const AskParams = z.object({
  to: requiredString('Missing --to'),
  question: requiredString('Missing --question'),
  options: OptionalString,
  timeoutMs: OptionalFiniteNumber,
  from: OptionalString
})

const ResetParams = z.object({
  all: OptionalBoolean,
  tasks: OptionalBoolean,
  messages: OptionalBoolean
})

export const ORCHESTRATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.send',
    params: SendParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'

      if (!isGroupAddress(params.to)) {
        // Point-to-point — existing single-recipient behavior
        const msg = db.insertMessage({
          from,
          to: params.to,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId: params.threadId,
          payload: params.payload
        })
        runtime.deliverPendingMessagesForHandle(params.to)
        runtime.notifyMessageArrived(params.to)
        return { message: msg }
      }

      // Why: group addresses fan out to one message per recipient so each gets
      // independent read-tracking, but they share a thread_id so the conversation
      // can be correlated (Section 4.5).
      const { terminals } = await runtime.listTerminals()
      const handles = resolveGroupAddress(params.to, from, terminals, (handle: string) =>
        runtime.getAgentStatusForHandle(handle)
      )

      if (handles.length === 0) {
        throw new Error(`No recipients resolved for group address: ${params.to}`)
      }

      const threadId = params.threadId ?? `thread_${Date.now()}`
      const messages = handles.map((handle) =>
        db.insertMessage({
          from,
          to: handle,
          subject: params.subject,
          body: params.body,
          type: params.type as MessageType,
          priority: params.priority as MessagePriority,
          threadId,
          payload: params.payload
        })
      )
      for (const handle of handles) {
        runtime.deliverPendingMessagesForHandle(handle)
        runtime.notifyMessageArrived(handle)
      }

      return { messages, recipients: handles.length }
    }
  }),

  defineMethod({
    name: 'orchestration.check',
    params: CheckParams,
    handler: async (params, { runtime, signal }) => {
      const db = runtime.getOrchestrationDb()
      const handle = params.terminal ?? 'unknown'
      const typeFilter = params.types
        ? (params.types
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean) as MessageType[])
        : undefined
      const invalidTypes = typeFilter?.filter((t) => !MESSAGE_TYPES.includes(t))
      if (invalidTypes && invalidTypes.length > 0) {
        throw new Error(`Invalid --types: ${invalidTypes.join(',')}`)
      }

      // Why: `all` short-circuits to "everything for the handle, no marking."
      // Explicit `unread: false` is also honored for one release as a compat
      // shim so in-flight callers don't break (see design doc §5). Otherwise
      // today's behavior is preserved: default is unread-only + mark-read.
      const showAll = params.all === true || params.unread === false
      const showUnread = !showAll

      const readAndReturn = () => {
        const messages = showUnread
          ? db.getUnreadMessages(handle, typeFilter)
          : db.getAllMessagesForHandle(handle)

        if (showUnread && messages.length > 0) {
          db.markAsRead(messages.map((m) => m.id))
        }

        if (params.inject) {
          const formatted = messages.map(formatMessageBanner).join('\n\n')
          return { messages, formatted, count: messages.length }
        }

        return { messages, count: messages.length }
      }

      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      const result = readAndReturn()
      if (result.count > 0 || !params.wait) {
        return result
      }

      // Why: blocking wait lets coordinators replace sleep+poll loops with a
      // single call that resolves when a message arrives or the timeout
      // expires. The `signal` plumbed from the RPC transport aborts this
      // waiter the moment the client socket closes, so a killed client
      // releases its long-poll slot immediately rather than after the full
      // timeoutMs. See design doc §3.1 counter-lifecycle.
      await runtime.waitForMessage(handle, {
        typeFilter: typeFilter as string[] | undefined,
        timeoutMs: params.timeoutMs ?? undefined,
        signal
      })
      if (signal?.aborted) {
        return { messages: [], count: 0 }
      }
      return readAndReturn()
    }
  }),

  defineMethod({
    name: 'orchestration.reply',
    params: ReplyParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const original = db.getMessageById(params.id)
      if (!original) {
        throw new Error(`Message not found: ${params.id}`)
      }

      db.markAsRead([original.id])

      const reply = db.insertMessage({
        from: params.from ?? original.to_handle,
        to: original.from_handle,
        subject: `Re: ${original.subject}`,
        body: params.body,
        threadId: original.thread_id ?? original.id
      })

      runtime.notifyMessageArrived(original.from_handle)
      return { message: reply }
    }
  }),

  defineMethod({
    name: 'orchestration.inbox',
    params: InboxParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: when `terminal` is provided, mirror `check --all` output for that
      // handle (same rows in the same sequence order). Stale/unknown handles
      // return an empty list instead of erroring, matching the "historical
      // rows survive handle deletion" rule in design doc §3.3.
      const messages = params.terminal
        ? db.getAllMessagesForHandle(params.terminal, params.limit)
        : db.getInbox(params.limit)
      return { messages, count: messages.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskCreate',
    params: TaskCreateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      let deps: string[] | undefined
      if (params.deps) {
        try {
          const parsed = JSON.parse(params.deps)
          if (!Array.isArray(parsed) || !parsed.every((d) => typeof d === 'string')) {
            throw new Error('not an array of strings')
          }
          deps = parsed
        } catch {
          throw new Error('Invalid --deps: must be a JSON array of task IDs')
        }
      }
      const task = db.createTask({
        spec: params.spec,
        deps,
        parentId: params.parent,
        createdByTerminalHandle: params.callerTerminalHandle
      })
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.taskList',
    params: TaskListParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      // Why: listTasksWithDispatch returns the same rows as listTasks plus
      // assignee_handle + dispatch_id joined in for tasks that currently have an
      // active dispatch. Non-dispatched tasks get NULL for those fields, so
      // consumers reading the legacy shape are unaffected.
      const joined = db.listTasksWithDispatch({
        status: params.status as TaskStatus,
        ready: params.ready
      })
      const tasks = joined.map((row) => {
        const { assignee_handle, dispatch_id, ...base } = row
        if (base.status === 'dispatched') {
          return { ...base, assignee_handle, dispatch_id }
        }
        return base
      })
      return { tasks, count: tasks.length }
    }
  }),

  defineMethod({
    name: 'orchestration.taskUpdate',
    params: TaskUpdateParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const task = db.updateTaskStatus(params.id, params.status, params.result)
      if (!task) {
        throw new Error(`Task not found: ${params.id}`)
      }
      return { task }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw new Error(`Task not found: ${params.task}`)
      }

      // Why: --inject --dry-run lets a coordinator preview the exact preamble
      // text that would be injected without mutating task state or touching the
      // target terminal. Skips the ready-status check so coordinators can inspect
      // the preamble for already-dispatched or blocked tasks too. No dispatch
      // context exists yet (that happens after the ready-status check), so
      // dispatchId is a placeholder — the real injected preamble gets a real
      // ctx.id below.
      if (params.dryRun) {
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          devMode: params.devMode
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      if (task.status !== 'ready') {
        throw new Error(`Task ${params.task} is ${task.status}; only ready tasks can be dispatched`)
      }

      // Why: dispatching with --inject to a bare shell (zsh/bash) dumps the
      // preamble as shell commands, producing gibberish. Check both OSC title
      // status and foreground process — Claude Code doesn't emit recognized OSC
      // titles on startup, so title-only detection misses freshly spawned agents.
      if (params.inject) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw new Error(
            `Cannot dispatch --inject to terminal ${to}: no recognized agent detected. ` +
              'Start an agent CLI (e.g. claude, codex, gemini) in the terminal first, ' +
              'or dispatch without --inject and send the prompt manually.'
          )
        }
      }

      const ctx = db.createDispatchContext(params.task, to)

      // Why: preamble is built here (not before ctx) so `dispatchId` can be
      // the real ctx.id — the preamble-hardening PR made dispatchId required
      // so heartbeats can attribute liveness to a specific dispatch context,
      // not just a task.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        taskSpec: task.spec,
        coordinatorHandle: params.from ?? 'coordinator',
        devMode: params.devMode
      })

      let injected = false
      if (params.inject) {
        try {
          await runtime.sendTerminal(to, { text: preamble, enter: true })
          injected = true
        } catch (err) {
          db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
          throw err
        }
      }

      // Why: returnPreamble is opt-in because the preamble is several hundred
      // bytes and most callers don't need it in the response. Exposing it
      // supports coordinators that want to log what was injected for auditing.
      if (params.returnPreamble) {
        return { dispatch: ctx, injected, preamble }
      }
      return { dispatch: ctx, injected }
    }
  }),

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)

      // Why: --preamble lets callers inspect the exact preamble text that was
      // (or would be) injected for this task. The preamble is derived from the
      // current task spec, so even after dispatch completes the text can be
      // regenerated deterministically.
      if (params.preamble) {
        const task = db.getTask(params.task)
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Why: prefer the existing dispatch context's id if we have one
          // (so the preview matches what was actually injected); fall back
          // to a placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          devMode: params.devMode
        })
        return { dispatch: ctx ?? null, preamble }
      }

      return { dispatch: ctx ?? null }
    }
  }),

  defineMethod({
    name: 'orchestration.ask',
    params: AskParams,
    handler: async (params, { runtime }) => {
      // Why: group addresses have no unambiguous answer semantics (whose
      // reply wins? first? consensus?) and the ~60-LOC scope is not the
      // place to design that. Rejecting here closes the silent-timeout
      // footgun where a worker passing `--to @reviewers` would have the
      // decision_gate inserted against a literal string no one subscribes
      // to. Workers that need fan-out fall back to `send --type decision_gate`.
      if (isGroupAddress(params.to)) {
        throw new Error(
          'ask does not support group addresses; use send --type decision_gate for fan-out questions'
        )
      }

      const db = runtime.getOrchestrationDb()
      const from = params.from ?? 'unknown'
      const timeoutMs = params.timeoutMs ?? 600_000
      const options =
        params.options
          ?.split(',')
          .map((s) => s.trim())
          .filter(Boolean) ?? []

      const payload = JSON.stringify({ question: params.question, options })
      const outbound = db.insertMessage({
        from,
        to: params.to,
        subject: 'Question',
        body: params.question,
        type: 'decision_gate',
        payload
      })
      runtime.deliverPendingMessagesForHandle(params.to)
      runtime.notifyMessageArrived(params.to)

      const threadId = outbound.id
      const deadline = Date.now() + timeoutMs
      const afterSequence = outbound.sequence

      // Why: loop with a remaining-budget guard so an unrelated distractor
      // message that wakes waitForMessage does not cause indefinite iteration.
      // waitForMessage is handle-scoped, so we re-query by thread on every
      // wake-up to separate "reply in my thread arrived" from "something
      // else was delivered to this handle."
      while (true) {
        const replies = db.getThreadMessagesFor(threadId, from, afterSequence)
        if (replies.length > 0) {
          const reply = replies[0]
          db.markAsRead([reply.id])
          return {
            answer: reply.body,
            messageId: reply.id,
            threadId,
            timedOut: false
          }
        }
        const remainingMs = deadline - Date.now()
        if (remainingMs <= 0) {
          return { answer: null, messageId: null, threadId, timedOut: true }
        }
        await runtime.waitForMessage(from, { timeoutMs: remainingMs })
      }
    }
  }),

  ...ORCHESTRATION_GATE_METHODS,

  defineMethod({
    name: 'orchestration.reset',
    params: ResetParams,
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (params.all) {
        db.resetAll()
        return { reset: 'all' }
      }
      if (params.tasks) {
        db.resetTasks()
        return { reset: 'tasks' }
      }
      if (params.messages) {
        db.resetMessages()
        return { reset: 'messages' }
      }
      db.resetAll()
      return { reset: 'all' }
    }
  })
]
