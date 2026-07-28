import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  appendReusedWorkerWorktreeEffects,
  createWorkerWorktree,
  initialWorkerSetupReceipt,
  monitorWorkerSetup,
  type WorkerEffect,
  type WorkerSetupReceipt,
  workerSetupSource
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import { failWorkerStartWithReceipt } from './orchestration-worker-start-receipt'
import {
  createOrchestrationAgentReadinessDeadline,
  prepareOrchestrationAgentPrompt,
  waitForOrchestrationProvisioning
} from './orchestration-agent-prompt-readiness'
import { deliverOrchestrationWorkerPrompt } from './orchestration-worker-prompt-delivery'
import { createOrchestrationWorkerTerminalIdentity } from './orchestration-worker-terminal-identity'
import { provisionWorkerTerminal } from './orchestration-worker-terminal-provisioning'
import { finalizeWorkerDispatch } from './orchestration-worker-finalization'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (params, { runtime, orchestrationMutation, signal }) => {
      const readiness = createOrchestrationAgentReadinessDeadline(
        'orchestration.workerStart',
        params,
        signal
      )
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
          orchestrationMutation,
          signal: readiness.signal,
          deadlineMs: readiness.deadlineMs
        })
      }

      const requestedWorktree = params.worktree ?? 'current'
      const createsWorktree =
        requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
      if (params.terminal && params.agent) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal reuses an existing agent and cannot combine with --agent.'
        )
      }
      if (createsWorktree && params.terminal) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal cannot combine with new-worktree creation.'
        )
      }
      if (createsWorktree && !params.name) {
        throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
      }
      if (!createsWorktree && (params.name || params.repo || params.baseBranch || params.setup)) {
        throw new OrchestrationError(
          'invalid_argument',
          'Creation and setup options apply only to new-child or new-top-level worktrees.'
        )
      }
      const agent = params.agent
      if (!params.terminal && (!agent || !isTuiAgent(agent))) {
        throw new OrchestrationError(
          'agent_unconfigured',
          'A configured --agent is required when worker-start creates a terminal.'
        )
      }
      if (agent) {
        runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
      }

      const coordinatorTerminal = await runtime.showTerminal(params.from)
      const coordinatorWorktree = await runtime.showManagedWorktree(
        `id:${coordinatorTerminal.worktreeId}`
      )
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo ?? coordinatorWorktree.repoId,
          existingPlacement: 'current or an exact existing folder workspace'
        })
      }
      let resolvedWorktree = createsWorktree
        ? undefined
        : requestedWorktree === 'current'
          ? coordinatorWorktree
          : await runtime.showManagedWorktree(requestedWorktree)
      let explicitTerminal
      if (params.terminal) {
        explicitTerminal = await runtime.showTerminal(params.terminal)
        if (explicitTerminal.worktreeId !== resolvedWorktree?.id) {
          throw new OrchestrationError(
            'terminal_worktree_mismatch',
            `Terminal ${params.terminal} does not belong to worktree ${resolvedWorktree?.id}.`
          )
        }
        if (
          !(await runtime.isTerminalRunningAgent(params.terminal, {
            signal: readiness.signal,
            deadlineMs: readiness.deadlineMs
          }))
        ) {
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
        repo: params.repo ?? (createsWorktree ? coordinatorWorktree.repoId : null),
        baseBranch: params.baseBranch ?? null,
        terminal: params.terminal ?? null,
        agent: agent ?? null,
        timeoutMs: params.timeoutMs ?? 60_000,
        setup: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        setupSource: workerSetupSource(createsWorktree, Boolean(params.setup))
      }
      const started = db.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: WorkerEffect[] = []
      const terminalIdentity = createOrchestrationWorkerTerminalIdentity(started.dispatch.id)
      appendReusedWorkerWorktreeEffects(effects, resolvedWorktree?.id)
      let terminalHandle = params.terminal
      let failedStage = 'terminal_create'
      let setupReceipt: WorkerSetupReceipt = initialWorkerSetupReceipt(false)
      try {
        if (createsWorktree) {
          failedStage = 'worktree_create'
          const created = await waitForOrchestrationProvisioning(
            createWorkerWorktree({
              runtime,
              db,
              dispatchId: started.dispatch.id,
              requestedWorktree,
              coordinatorWorktree,
              params,
              agent: agent as TuiAgent,
              effects,
              signal: readiness.signal,
              terminalIdentity
            }),
            readiness.signal
          )
          resolvedWorktree = created.worktree
          terminalHandle = created.terminalHandle
          setupReceipt = created.setupReceipt
        } else if (!terminalHandle) {
          const terminal = await provisionWorkerTerminal({
            runtime,
            db,
            dispatchId: started.dispatch.id,
            worktreeId: resolvedWorktree!.id,
            taskId: task.id,
            agent: agent as TuiAgent,
            signal: readiness.signal,
            terminalIdentity,
            effects
          })
          terminalHandle = terminal.handle
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
        const promptTarget = await prepareOrchestrationAgentPrompt(runtime, terminalHandle, {
          deadlineMs: readiness.deadlineMs,
          signal: readiness.signal,
          onWaitResult: (wait) => {
            persistWorkerSetupWaitOutcome({ ...setupStage, wait })
            if (!wait.satisfied && setupReceipt.state === 'failed') {
              failedStage = 'setup_wait'
            }
          }
        })
        const capability = db.prepareStartingWorkerAuthority({
          dispatchId: started.dispatch.id,
          handle: terminalHandle,
          paneKey: promptTarget.paneKey,
          processIncarnation: promptTarget.processIncarnation,
          worktreeId: resolvedWorktree.id,
          effects,
          setupState: setupReceipt.state
        })

        failedStage = 'dispatch_input'
        await deliverOrchestrationWorkerPrompt({
          runtime,
          terminalHandle,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from,
          dispatchCapability: capability,
          devMode: params.devMode,
          beforeWrite: promptTarget.beforeWrite,
          effects
        })
        const worker = finalizeWorkerDispatch(db, started.dispatch.id, effects)
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
          timeoutMs: readiness.timeoutMs,
          effects,
          residualResources: []
        }
      } catch (error) {
        return failWorkerStartWithReceipt({
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          failedStage,
          error,
          setup: setupReceipt
        })
      }
    }
  })
]
