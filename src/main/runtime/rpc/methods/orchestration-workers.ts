import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  deliverWorkerDispatchInput,
  failLocalWorkerStart,
  finalizeWorkerStart,
  prepareWorkerDispatchPreamble
} from './orchestration-worker-lifecycle'
import { mergeZcodeProviderWarning, waitForZcodeReadiness } from './orchestration-worker-zcode'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

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
      const promptDeliveryWorktree = creationWorktree ?? resolvedWorktree
      const createdTerminalPromptDelivery =
        agent && promptDeliveryWorktree
          ? await runtime.resolveOrchestrationPromptDelivery(agent, promptDeliveryWorktree.id)
          : 'agent-input'
      const interactiveAgentCommand =
        agent && createdTerminalPromptDelivery === 'agent-input' && promptDeliveryWorktree
          ? await runtime.resolveOrchestrationInteractiveAgentCommand(
              agent,
              promptDeliveryWorktree.id
            )
          : undefined
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
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: WorkerEffect[] = []
      const launchObservedAfter = Date.now()
      if (resolvedWorktree) {
        effects.push(
          { kind: 'worktree', action: 'reused', id: resolvedWorktree.id },
          { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
        )
      }
      let terminalHandle = params.terminal
      let promptDelivery: 'agent-input' | 'startup-command' = 'agent-input'
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
            promptDelivery: createdTerminalPromptDelivery,
            interactiveAgentCommand,
            effects
          })
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
          promptDelivery = createdTerminalPromptDelivery
        } else if (!terminalHandle) {
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
            taskId: task.id,
            promptDelivery: createdTerminalPromptDelivery,
            interactiveAgentCommand,
            effects
          })
          terminalHandle = terminal.handle
          terminalRevealWarning = terminal.warning
          promptDelivery = terminal.promptDelivery
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
        await waitForZcodeReadiness({
          runtime,
          terminalHandle,
          agent: agent as TuiAgent,
          promptDelivery,
          timeoutMs: params.timeoutMs ?? 60_000
        })
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
        const preamble = prepareWorkerDispatchPreamble({
          runtime,
          db,
          taskId: task.id,
          taskSpec: task.spec,
          dispatchId: started.dispatch.id,
          coordinatorHandle: params.from,
          terminalHandle,
          worktreeId: resolvedWorktree.id,
          effects,
          setupState: setupReceipt.state,
          terminalOwnership: params.terminal ? 'external' : 'created',
          devMode: params.devMode,
          promptDelivery
        })

        failedStage = 'dispatch_input'
        await deliverWorkerDispatchInput({
          runtime,
          terminalHandle,
          agent: agent as TuiAgent,
          promptDelivery,
          preamble,
          launchPreferences: launch.preferences,
          effects
        })
        terminalRevealWarning = await mergeZcodeProviderWarning(terminalRevealWarning, {
          runtime,
          terminalHandle,
          agent: agent as TuiAgent,
          promptDelivery,
          observedAfter: launchObservedAfter,
          timeoutMs: params.timeoutMs ?? 60_000
        })
        return finalizeWorkerStart({
          runtime,
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          timeoutMs: params.timeoutMs ?? 60_000,
          setupReceipt,
          launchReceipt: launch.receipt,
          effects,
          warning: terminalRevealWarning
        })
      } catch (error) {
        return failLocalWorkerStart({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt,
          launch: launch.receipt,
          agent,
          promptDelivery
        })
      }
    }
  })
]
