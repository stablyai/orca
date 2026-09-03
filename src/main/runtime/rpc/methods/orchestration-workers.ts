import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import { resolveArgvWorktreeLaunch } from './orchestration-worker-authority'
import { startArgvWorkerDispatch } from './orchestration-worker-argv-start'
import { attachWorkerAndAwaitReadiness } from './orchestration-worker-readiness'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          `--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.`
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      const db = runtime.getOrchestrationDb()
      // Why: worker-start was the only Run-scoped verb that skipped this, so a
      // declared --from could name someone else's pane and inherit their depth.
      const coordinatorPane = resolveOrchestrationCaller(runtime, {
        callerTerminalHandle: params.from,
        callerEvidence: orchestrationCompatibilityEvidence
      })
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      if (params.on) {
        return startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation
        })
      }

      const requestedWorktree = params.worktree ?? 'current'
      const createsWorktree =
        requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
      const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })

      const coordinatorTerminal = await runtime.showTerminal(params.from)
      const creationWorktree = createsWorktree
        ? await runtime.showManagedWorktree(`id:${coordinatorTerminal.worktreeId}`)
        : undefined
      if (creationWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo ?? creationWorktree.repoId,
          existingPlacement: 'current or an exact existing folder workspace'
        })
      }
      let resolvedWorktree = creationWorktree
        ? undefined
        : requestedWorktree === 'current'
          ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
          : await runtime.showManagedTerminalWorkspace(requestedWorktree)
      let explicitTerminal
      if (params.terminal) {
        explicitTerminal = await runtime.showTerminal(params.terminal)
        if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
          throw new OrchestrationError(
            'terminal_worktree_mismatch',
            `Terminal ${params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
          )
        }
        if (!(await runtime.isTerminalRunningAgent(params.terminal))) {
          throw new OrchestrationError(
            'agent_unconfigured',
            `Terminal ${params.terminal} is not running a recognized agent.`
          )
        }
      }

      const startOptions = {
        worktree: requestedWorktree,
        resolvedWorktreeId: resolvedWorktree?.id ?? null,
        name: params.name ?? null,
        repo: params.repo ?? creationWorktree?.repoId ?? null,
        baseBranch: params.baseBranch ?? null,
        terminal: params.terminal ?? null,
        agent: agent ?? null,
        launch: launch.receipt,
        timeoutMs: readinessTimeoutMs,
        setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        setupSource: createsWorktree
          ? params.setup
            ? 'explicit_request'
            : 'orchestration_default'
          : 'existing_worktree'
      }
      const started = db.createStartingWorkerDispatch({
        creator: resolveDispatchCreator(runtime, params.from),
        maxDepth: runtime.getNestedWorkerMaxDepth(),
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: WorkerEffect[] = []
      const argvWorktreeLaunch = resolveArgvWorktreeLaunch({
        creationWorktree: Boolean(creationWorktree),
        agent,
        runtime,
        db,
        task,
        dispatchId: started.dispatch.id,
        coordinatorHandle: params.from,
        devMode: params.devMode,
        effects
      })
      if (resolvedWorktree) {
        effects.push(
          { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
          { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
        )
      }
      let terminalHandle = params.terminal
      let terminalRevealWarning: string | undefined
      let failedStage = 'terminal_create'
      let setupReceipt: WorkerSetupReceipt = {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      }
      try {
        if (creationWorktree) {
          failedStage = 'worktree_create'
          const created = await createWorkerWorktree({
            runtime,
            db,
            dispatchId: started.dispatch.id,
            requestedWorktree,
            coordinatorWorktree: creationWorktree,
            params,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            argvWorktreeLaunch,
            effects
          })
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
          failedStage = argvWorktreeLaunch ? 'authority_bind' : failedStage
          argvWorktreeLaunch?.assertTerminalHandle(terminalHandle)
        } else if (!terminalHandle) {
          db.recordWorkerStage({
            dispatchId: started.dispatch.id,
            stage: 'terminal_creating',
            worktreeId: resolvedWorktree!.id,
            effects
          })
          if (agent && TUI_AGENT_CONFIG[agent].promptInjectionMode === 'argv') {
            return await startArgvWorkerDispatch({
              runtime,
              db,
              runId: run.id,
              task,
              dispatchId: started.dispatch.id,
              coordinatorHandle: params.from,
              devMode: params.devMode,
              timeoutMs: readinessTimeoutMs,
              agent,
              launchPreferences: launch.preferences,
              launchReceipt: launch.receipt,
              worktreeId: resolvedWorktree!.id,
              effects,
              setupReceipt,
              onStage: (stage) => {
                failedStage = stage
              }
            })
          }
          const terminal = await createExistingWorktreeWorkerTerminal({
            runtime,
            worktreeId: resolvedWorktree!.id,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            taskId: task.id,
            effects
          })
          terminalHandle = terminal.handle
          terminalRevealWarning = terminal.warning
        } else {
          effects.push({
            kind: 'terminal',
            role: 'agent',
            action: 'reused',
            id: terminalHandle
          })
        }
        if (!resolvedWorktree || !terminalHandle) {
          throw new Error('Worker topology did not resolve an agent terminal and worktree.')
        }
        const worker = await attachWorkerAndAwaitReadiness({
          runtime,
          db,
          runId: run.id,
          dispatchId: started.dispatch.id,
          terminalHandle,
          worktreeId: resolvedWorktree.id,
          effects,
          setupReceipt,
          terminalOwnership: params.terminal ? 'external' : 'created',
          task,
          coordinatorHandle: params.from,
          devMode: params.devMode,
          argv: Boolean(argvWorktreeLaunch),
          timeoutMs: readinessTimeoutMs,
          onStage: (stage) => {
            failedStage = stage
          }
        })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          state: worker.state,
          stage: worker.stage,
          setup: setupReceipt,
          launch: launch.receipt,
          timeoutMs: readinessTimeoutMs,
          effects,
          residualResources: [],
          ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
        }
      } catch (error) {
        return failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt,
          launch: launch.receipt
        })
      }
    }
  })
]
