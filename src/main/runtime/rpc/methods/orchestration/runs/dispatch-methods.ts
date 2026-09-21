import { defineMethod, type RpcMethod } from '../../../core'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import { resolveDispatchCreator } from './dispatch-creator'
import {
  injectRejectedError,
  taskNotFoundError,
  taskNotStartableError
} from '../../../../orchestration/task-dispatch-refusal'
import { resolveRunScope } from './run-scope'
import { DispatchParams, DispatchShowParams } from '../schemas'

export const ORCHESTRATION_DISPATCH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.dispatch',
    params: DispatchParams,
    handler: async (
      params,
      {
        orchestrationCompatibilityEvidence,
        runtime,
        legacyCoordinatorRunId,
        revalidateLegacyCoordinator,
        orchestrationMutation
      }
    ) => {
      const db = runtime.getOrchestrationDb()
      const task = db.getTask(params.task)
      if (!task) {
        throw taskNotFoundError(`Task not found: ${params.task}`, { taskId: params.task })
      }
      const run = resolveRunScope(runtime, {
        runId: params.run,
        callerTerminalHandle: params.from,
        requireCurrentConsumer: true,
        legacyCoordinatorRunId,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      if (task.run_id !== run.id) {
        throw taskNotFoundError(`Task ${task.id} was not found in Run ${run.id}.`, {
          taskId: task.id,
          runId: run.id
        })
      }

      // Why: dry-run previews the preamble without mutating state, so it skips the ready-status check and uses a placeholder dispatchId.
      if (params.dryRun) {
        const maxDepth = runtime.getNestedWorkerMaxDepth()
        const previewDepth = db.resolveChildDispatchDepth(
          resolveDispatchCreator(runtime, params.from),
          maxDepth
        )
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: 'ctx_dryrun',
          canDispatchSubWorkers: previewDepth < maxDepth,
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle: params.to ?? 'worker',
          devMode: params.devMode,
          ...(params.to
            ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(params.to) }
            : {})
        })
        return { dispatch: null, injected: false, dryRun: true, preamble }
      }

      if (!params.to) {
        throw new Error('Missing --to')
      }
      const to = params.to

      if (task.status !== 'ready') {
        throw taskNotStartableError(
          db,
          `Task ${params.task} is ${task.status}; only ready tasks can be dispatched`,
          task
        )
      }

      const dispatchAuthority = runtime.getOrchestrationDispatchAuthority(to)
      const assigneePaneKey =
        dispatchAuthority?.paneKey ?? runtime.getTerminalPaneKey(to) ?? undefined
      const processIncarnation =
        dispatchAuthority?.paneKey && dispatchAuthority.processIncarnation
          ? dispatchAuthority.processIncarnation
          : undefined
      // Why: the assignee side prefers dispatch authority, so the caller side must too — getTerminalPaneKey
      // alone returns null for a handle reachable only through the window-graph leaf, going inert here.
      const callerPane = params.from
        ? (runtime.getOrchestrationDispatchAuthority(params.from)?.paneKey ??
          runtime.getTerminalPaneKey(params.from) ??
          null)
        : null
      if (
        params.inject &&
        params.from &&
        (to === params.from || (assigneePaneKey != null && assigneePaneKey === callerPane))
      ) {
        // An injected preamble into the coordinator's own pane makes it answer itself forever
        // (worker-start --terminal is the other door). A context-only self-dispatch writes
        // nothing into the pane and stays legal for low-level topologies.
        throw new OrchestrationError(
          'terminal_is_coordinator',
          `Terminal ${to} is this coordinator's own terminal. Dispatch to a different agent pane, or use worker-start to create one.`
        )
      }

      // Why: injecting the preamble into a bare shell dumps it as shell commands (gibberish), so require a detected agent first.
      if (params.inject) {
        const hasAgent = await runtime.isTerminalRunningAgent(to)
        if (!hasAgent) {
          throw injectRejectedError(to, 'no_agent_detected')
        }
      }

      if (params.inject && (!assigneePaneKey || !processIncarnation)) {
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
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth()
      })
      const dispatchCapability = params.inject
        ? db.mintDispatchCapability({
            dispatchId: ctx.id,
            paneKey: assigneePaneKey as string,
            processIncarnation: processIncarnation as string
          })
        : undefined

      // Why: built after ctx so dispatchId is the real ctx.id, letting heartbeats attribute liveness to a specific dispatch context, not just a task.
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: ctx.id,
        canDispatchSubWorkers: ctx.depth < runtime.getNestedWorkerMaxDepth(),
        taskSpec: task.spec,
        coordinatorHandle: params.from ?? 'coordinator',
        workerHandle: to,
        dispatchCapability,
        devMode: params.devMode,
        cliCommand: runtime.getTerminalOrchestrationCliCommand(to)
      })

      let injected = false
      let prompt
      if (params.inject) {
        try {
          prompt = await runtime.sendTerminalAgentPrompt(to, preamble, {
            // A delayed provider hook must not revoke an accepted Dispatch.
            acceptQueued: true,
            observationTimeoutMs: 0,
            requestId: orchestrationMutation?.requestId ?? ctx.id
          })
          injected = true
        } catch (err) {
          db.failDispatch(ctx.id, err instanceof Error ? err.message : String(err))
          throw err
        }
      }

      // Why: returnPreamble is opt-in because the preamble is several hundred bytes most callers don't need in the response.
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

  defineMethod({
    name: 'orchestration.dispatchShow',
    params: DispatchShowParams,
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
          // Why: use the real ctx.id when present so the preview matches what was injected; placeholder when no dispatch has occurred yet.
          dispatchId: ctx?.id ?? 'ctx_preview',
          canDispatchSubWorkers: (ctx?.depth ?? 1) < runtime.getNestedWorkerMaxDepth(),
          taskSpec: task.spec,
          coordinatorHandle: params.from ?? 'coordinator',
          workerHandle,
          devMode: params.devMode,
          ...(ctx ? { cliCommand: runtime.getTerminalOrchestrationCliCommand(workerHandle) } : {})
        })
        return { dispatch: ctx ?? null, preamble }
      }

      return { dispatch: ctx ?? null }
    }
  })
]
