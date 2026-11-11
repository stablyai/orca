import { defineOrchestrationMethod } from '../access/orchestration-method-access'
import { dispatchAccess } from '../access/run-access-rules'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../../../orchestration/workers/launch/worker-dispatch-preamble'
import { sendAgentTurn } from '../../../../orchestration/turn-delivery/send-agent-turn'
import { resolveDispatchCreator } from './dispatch-creator'
import {
  injectRejectedError,
  taskNotStartableError
} from '../../../../orchestration/coordinator/dispatch/task-dispatch-refusal'
import {
  DispatchParams,
  DispatchShowParams
} from '../../../../../../shared/rpc-contract/orchestration-params'
import {
  orcaSessionIdOrHandle,
  resolveDispatchAssigneeParty
} from '../../../../orchestration/addressing/orchestration-party'
import {
  admitChatAssignee,
  chatAssigneeOf,
  refuseChatSelfAssignment
} from '../chat-assignee-admission'
import { sendChatTask } from '../chat-task-delivery'
import { dispatchTaskSource } from '../../../../orchestration/coordinator/dispatch/dispatch-task-source'

export const ORCHESTRATION_DISPATCH_METHODS = [
  defineOrchestrationMethod({
    name: 'orchestration.dispatch',
    permission: 'workspace',
    params: DispatchParams,
    access: {
      kind: 'writes',
      caller: 'from',
      targets: { task: 'task', to: 'party', run: 'run' },
      rule: dispatchAccess
    },
    handler: async (
      params,
      { orchestrationCaller, runtime, revalidateLegacyCoordinator, orchestrationMutation },
      { task }
    ) => {
      const db = runtime.getOrchestrationDb()
      const assigneeParty = params.to ? resolveDispatchAssigneeParty(params.to, db) : undefined
      const assignee = assigneeParty?.address
      // A chat has no pane, process or agent to probe: it is reached as mail to it is.
      const chatAssignee = assigneeParty ? chatAssigneeOf(assigneeParty) : null
      if (chatAssignee) {
        await admitChatAssignee(runtime, chatAssignee, db)
      }

      // Dry-run previews without state changes; skip readiness and use a placeholder Dispatch id.
      if (params.dryRun) {
        const maxDepth = runtime.getNestedWorkerMaxDepth()
        const previewDepth = db.resolveChildDispatchDepth(
          resolveDispatchCreator(runtime, params.from, orchestrationCaller),
          maxDepth
        )
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          canDispatchSubWorkers: previewDepth < maxDepth,
          taskSpec: task.spec,
          coordinatorHandle: orcaSessionIdOrHandle(params.from ?? 'coordinator', db),
          workerHandle: assignee ? orcaSessionIdOrHandle(assignee, db) : 'worker',
          devMode: params.devMode,
          ...(assignee ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(assignee) } : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!assignee) {
        throw new Error('Missing --to')
      }
      const to = assignee

      if (task.status !== 'ready') {
        throw taskNotStartableError(
          db,
          `Task ${params.task} is ${task.status}; only ready tasks can be dispatched`,
          task
        )
      }

      // A structured worker's chat keeps the pane and process its custody is held under.
      const sessionOnly = assigneeParty?.terminalHandle === null
      const dispatchAuthority = sessionOnly ? null : runtime.getOrchestrationDispatchAuthority(to)
      const assigneePaneKey = sessionOnly
        ? undefined
        : (dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey(to) ?? undefined)
      const processIncarnation =
        dispatchAuthority?.paneKey && dispatchAuthority.processIncarnation
          ? dispatchAuthority.processIncarnation
          : undefined
      // Resolve dispatch authority on both sides; pane lookup alone misses window-graph-only handles.
      const callerPane = params.from
        ? (runtime.getOrchestrationDispatchAuthority(params.from)?.paneKey ??
          runtime.getTerminalPaneKey(params.from) ??
          null)
        : null
      if (params.inject && chatAssignee) {
        // The session wins over `--from`, so a chat calling with none is still refused here.
        refuseChatSelfAssignment({
          sessionId: chatAssignee,
          coordinatorSessionId: orchestrationCaller?.orcaSessionId,
          remedy: 'Dispatch to a different agent, or use worker-start to create one.'
        })
      }
      if (
        params.inject &&
        params.from &&
        (to === params.from || (assigneePaneKey != null && assigneePaneKey === callerPane))
      ) {
        // Refuse self-injected preambles to avoid endless self-answering; context-only topology dispatch remains legal.
        throw new OrchestrationError(
          'terminal_is_coordinator',
          `Terminal ${to} is this coordinator's own terminal. Dispatch to a different agent pane, or use worker-start to create one.`
        )
      }

      // Require a detected agent before injection so a bare shell cannot execute the preamble.
      if (params.inject && !chatAssignee) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw injectRejectedError(to, 'no_agent_detected')
        }
      }

      if (params.inject && !sessionOnly && (!assigneePaneKey || !processIncarnation)) {
        throw new OrchestrationError(
          'stable_pane_required',
          `Terminal ${to} has no stable pane/process incarnation for lifecycle authority.`
        )
      }

      revalidateLegacyCoordinator?.()
      const ctx = db.createDispatchContext({
        taskId: params.task,
        assigneeHandle: to,
        assigneePaneKey,
        launchTokenHash: dispatchAuthority?.launchTokenHash ?? undefined,
        processIncarnation,
        hostScope: dispatchAuthority?.hostScope
          ? JSON.stringify(dispatchAuthority.hostScope)
          : null,
        creator: resolveDispatchCreator(runtime, params.from, orchestrationCaller),
        maxDepth: runtime.getNestedWorkerMaxDepth()
      })

      // Build after ctx so worker_done carries this Dispatch's real id.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        canDispatchSubWorkers: ctx.depth < runtime.getNestedWorkerMaxDepth(),
        taskSpec: task.spec,
        coordinatorHandle: orcaSessionIdOrHandle(params.from ?? 'coordinator', db),
        workerHandle: orcaSessionIdOrHandle(to, db),
        devMode: params.devMode,
        cliCommand: runtime.getTerminalOrchestrationCliCommand(to)
      })

      let injected = false
      let prompt
      if (params.inject) {
        try {
          if (chatAssignee) {
            const from = dispatchTaskSource({
              db,
              dispatch: ctx,
              from: params.from,
              senderSnapshot: (party, reported) =>
                runtime.orchestrationSenderNames.snapshotOf(party, reported)
            })
            await sendChatTask({ db, dispatch: ctx, from, preamble })
          } else {
            prompt = await sendAgentTurn({
              kind: 'terminal',
              runtime,
              handle: to,
              turn: {
                purpose: 'dispatch-preamble',
                body: preamble,
                operationId: orchestrationMutation?.requestId ?? ctx.id
              }
            })
          }
          injected = true
        } catch (err) {
          // Unknown delivery may still be running; keep Dispatch open for its report or explicit abandon.
          if (!(err instanceof OrchestrationError && err.code === 'operation_unknown')) {
            db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
          }
          throw err
        }
      }

      // Opt into returning the preamble to avoid hundreds of unnecessary response bytes.
      if (params.returnPreamble) {
        return {
          dispatch: ctx,
          injected,
          preamble,
          ...(prompt?.prompt ? { prompt: prompt.prompt } : {})
        }
      }
      return { dispatch: ctx, injected, ...(prompt?.prompt ? { prompt: prompt.prompt } : {}) }
    }
  }),

  defineOrchestrationMethod({
    name: 'orchestration.dispatchShow',
    permission: 'workspace',
    params: DispatchShowParams,
    access: { kind: 'reads', targets: { task: 'task' } },
    handler: (params, { runtime }) => {
      const db = runtime.getOrchestrationDb()
      if (!params.task) {
        throw new Error('Missing --task')
      }
      const ctx = db.getDispatchContext(params.task)

      // Why: the preamble is derived from the current task spec, so it can be regenerated deterministically even after dispatch completes.
      if (params.preamble) {
        const task = db.getTask(params.task)
        if (!task) {
          throw new Error(`Task not found: ${params.task}`)
        }
        const workerHandle = ctx?.assignee_handle ?? 'worker'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          // Use the real Dispatch id for matching previews; use a placeholder before dispatch.
          dispatchId: ctx?.id ?? 'ctx_preview',
          canDispatchSubWorkers: (ctx?.depth ?? 1) < runtime.getNestedWorkerMaxDepth(),
          taskSpec: task.spec,
          coordinatorHandle: orcaSessionIdOrHandle(params.from ?? 'coordinator', db),
          workerHandle: orcaSessionIdOrHandle(workerHandle, db),
          devMode: params.devMode,
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {})
        })
        return { dispatch: ctx ?? null, preamble }
      }

      return { dispatch: ctx ?? null }
    }
  })
]
