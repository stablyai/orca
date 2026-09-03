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
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import { resolveDispatchCreator } from './orchestration-dispatch-creator'
import { resolveOrchestrationCaller } from './orchestration-run-scope'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../shared/orchestration-timing-budgets'
import {
  finishReadyWorkerStart,
  recoverStalledWorkerPrompt
} from './orchestration-worker-prompt-recovery'
import {
  buildWorkerStartOptions,
  validateExplicitWorkerTerminal
} from './orchestration-worker-start-options'

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
      if (params.terminal) {
        await validateExplicitWorkerTerminal({
          runtime,
          terminalHandle: params.terminal,
          worktreeId: resolvedWorktree?.id
        })
      }

      const startOptions = buildWorkerStartOptions({
        requestedWorktree,
        resolvedWorktreeId: resolvedWorktree?.id,
        creationRepoId: creationWorktree?.repoId,
        name: params.name,
        repo: params.repo,
        baseBranch: params.baseBranch,
        terminal: params.terminal,
        agent,
        launch: launch.receipt,
        timeoutMs: readinessTimeoutMs,
        setup: params.setup,
        createsWorktree
      })
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
      if (resolvedWorktree) {
        effects.push(
          { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
          { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
        )
      }
      let terminalHandle = params.terminal
      const deliveryState: { warning?: string; incarnation?: string; submittedAt?: number } = {}
      let failedStage = 'terminal_create'
      let setupReceipt: WorkerSetupReceipt = {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      }
      const finishReady = (worker: { state: string; stage: string }) =>
        finishReadyWorkerStart({
          runtime,
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          worker,
          setup: setupReceipt,
          launch: launch.receipt,
          timeoutMs: readinessTimeoutMs,
          effects,
          warning: deliveryState.warning
        })
      try {
        if (creationWorktree) {
          failedStage = 'worktree_create'
          const created = await createWorkerWorktree({
            runtime,
            db,
            dispatchId: started.dispatch.id,
            runId: run.id,
            taskId: task.id,
            requestedWorktree,
            coordinatorWorktree: creationWorktree,
            params,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            effects
          })
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
        } else if (!terminalHandle) {
          db.recordWorkerStage({
            dispatchId: started.dispatch.id,
            stage: 'terminal_creating',
            worktreeId: resolvedWorktree!.id,
            effects
          })
          const terminal = await createExistingWorktreeWorkerTerminal({
            runtime,
            worktreeId: resolvedWorktree!.id,
            agent: agent as TuiAgent,
            launchPreferences: launch.preferences,
            taskId: task.id,
            effects
          })
          terminalHandle = terminal.handle
          deliveryState.warning = terminal.warning
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
          timeoutMs: readinessTimeoutMs
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
        const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
        deliveryState.incarnation = terminalAuthority.processIncarnation
        const capability = db.prepareStartingWorkerAuthority({
          dispatchId: started.dispatch.id,
          handle: terminalHandle,
          ...terminalAuthority,
          worktreeId: resolvedWorktree.id,
          effects,
          setupState: setupReceipt.state,
          terminalOwnership: params.terminal ? 'external' : 'created'
        })

        failedStage = 'dispatch_input'
        const preamble = buildDispatchPreamble({
          canDispatchSubWorkers: started.dispatch.depth < runtime.getNestedWorkerMaxDepth(),
          taskId: task.id,
          dispatchId: started.dispatch.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from,
          workerHandle: terminalHandle,
          dispatchCapability: capability,
          devMode: params.devMode,
          cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
        })
        deliveryState.submittedAt = Date.now()
        await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
        effects.push({
          kind: 'dispatch_input',
          role: 'agent',
          id: terminalHandle,
          state: 'accepted'
        })
        const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
        return finishReady(worker)
      } catch (error) {
        const recovered = recoverStalledWorkerPrompt({
          error,
          runtime,
          db,
          terminalHandle,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          processIncarnation: deliveryState.incarnation,
          submittedAt: deliveryState.submittedAt,
          effects
        })
        if (recovered) {
          return finishReady(recovered)
        }
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
