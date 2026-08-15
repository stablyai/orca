import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  monitorWorkerSetup,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome,
  WorkerSetupGateError
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  prepareLocalWorkerStart,
  resolveBoundedWorkerControls,
  resolveWorkerDeadlineAt
} from './orchestration-worker-start-validation'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const coordinatorPane = runtime.getTerminalPaneKey(params.from)
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
      const controls = resolveBoundedWorkerControls(params, agent as TuiAgent)
      const deadlineAt = resolveWorkerDeadlineAt({
        db,
        retryOf: params.retryOf,
        maxRuntimeMs: params.maxRuntimeMs
      })
      const bounded = {
        deadlineAt,
        budget: controls.budget,
        leafControl: controls.leafControl
      }

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
      const startOptions = {
        worktree: requestedWorktree,
        resolvedWorktreeId: resolvedWorktree?.id ?? null,
        name: params.name ?? null,
        repo: params.repo ?? creationWorktree?.repoId ?? null,
        baseBranch: params.baseBranch ?? null,
        terminal: null,
        agent: agent ?? null,
        launch: launch.receipt,
        bounded,
        timeoutMs: params.timeoutMs ?? 60_000,
        setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        setupSource: createsWorktree
          ? params.setup
            ? 'explicit_request'
            : 'orchestration_default'
          : 'existing_worktree'
      }
      const started = db.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions,
        budget: controls.budget,
        deadlineAt,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: WorkerEffect[] = []
      if (resolvedWorktree) {
        effects.push(
          { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
          { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
        )
      }
      let terminalHandle: string | undefined
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
            deadlineAt,
            maxRequests: params.maxRequests,
            effects,
            onStage: (stage) => {
              failedStage = stage
            }
          })
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
        } else {
          db.recordWorkerStage({
            dispatchId: started.dispatch.id,
            stage: 'terminal_creating',
            worktreeId: resolvedWorktree!.id,
            effects
          })
          const terminal = await createExistingWorktreeWorkerTerminal({
            runtime,
            db,
            dispatchId: started.dispatch.id,
            worktreeId: resolvedWorktree!.id,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            deadlineAt,
            maxRequests: params.maxRequests,
            taskId: task.id,
            effects
          })
          terminalHandle = terminal.handle
          terminalRevealWarning = terminal.warning
        }
        if (!resolvedWorktree || !terminalHandle) {
          throw new Error('Worker topology did not resolve an agent terminal and worktree.')
        }
        const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
        const capability = db.prepareStartingWorkerAuthority({
          dispatchId: started.dispatch.id,
          handle: terminalHandle,
          ...terminalAuthority,
          worktreeId: resolvedWorktree.id,
          effects,
          setupState: setupReceipt.state,
          terminalOwnership: 'created'
        })
        const setupStage = {
          db,
          dispatchId: started.dispatch.id,
          worktreeId: resolvedWorktree.id,
          terminalHandle,
          setup: setupReceipt,
          effects
        }
        if (persistGatedSetupSpawnFailure(setupStage)) {
          failedStage = 'setup_start'
          throw new Error('Setup terminal failed to start before the gated agent launch.')
        }
        persistWorkerReadinessStage(setupStage)

        failedStage = 'agent_readiness'
        const wait = await runtime.waitForTerminal(terminalHandle, {
          condition: 'tui-idle',
          timeoutMs: params.timeoutMs ?? 60_000
        })
        persistWorkerSetupWaitOutcome({ ...setupStage, wait })
        if (!wait.satisfied) {
          if (setupReceipt.state === 'failed') {
            failedStage = 'setup_wait'
          }
          throw new Error(
            wait.blockedReason
              ? `Agent startup blocked: ${wait.blockedReason}`
              : `Agent did not become ready (${wait.status}).`
          )
        }
        failedStage = 'dispatch_input'
        const preamble = buildDispatchPreamble({
          taskId: task.id,
          dispatchId: started.dispatch.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from,
          workerHandle: terminalHandle,
          maxRequests: params.maxRequests,
          dispatchCapability: capability,
          devMode: params.devMode,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
        })
        await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
        effects.push({
          kind: 'dispatch_input',
          role: 'agent',
          id: terminalHandle,
          state: 'accepted'
        })
        const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
        monitorWorkerSetup({
          runtime,
          db,
          runId: run.id,
          dispatchId: started.dispatch.id,
          setupReceipt,
          effects
        })
        return {
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          state: worker.state,
          stage: worker.stage,
          setup: setupReceipt,
          launch: launch.receipt,
          ...bounded,
          timeoutMs: params.timeoutMs ?? 60_000,
          effects,
          residualResources: [],
          ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
        }
      } catch (error) {
        if (error instanceof WorkerSetupGateError) {
          failedStage = error.failedStage
          setupReceipt = error.setupReceipt
        }
        return failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt,
          launch: launch.receipt,
          bounded
        })
      }
    }
  })
]
