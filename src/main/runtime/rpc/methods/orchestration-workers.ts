import type { TuiAgent } from '../../../../shared/tui-agent'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
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
  consumeWorkerAuthorityCapability,
  createWorkerAuthorityLaunch,
  monitorWorkerAuthorityLifecycle,
  persistWorkerAuthorityAttestation
} from './orchestration-worker-authority-launch'
import {
  buildInitialWorkerPlacementReceipt,
  buildWorkerStartOptions,
  resolveWorkerStartTimeoutMs,
  sendWorkerDispatchInput
} from './orchestration-worker-start-record'
import { resolveLocalWorkerPlacement } from './orchestration-worker-placement-resolution'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (
      params,
      { runtime, orchestrationMutation, orchestrationCompatibilityEvidence }
    ) => {
      const readinessTimeoutMs = resolveWorkerStartTimeoutMs(params.timeoutMs)
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

      if (Boolean(params.policy) !== Boolean(params.capabilityRef)) {
        throw new OrchestrationError(
          'worker_authority_capability_stale',
          'worker-start requires --policy and --capability-ref together.'
        )
      }

      if (params.on) {
        if (params.policy) {
          throw new OrchestrationError(
            'worker_authority_policy_unsupported',
            'Federated workers do not yet support NO_GITHUB_AUTHORITY.'
          )
        }
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

      const placementResolution = await resolveLocalWorkerPlacement({
        params,
        runtime,
        requestedWorktree,
        createsWorktree
      })
      const creationWorktree = placementResolution.creationWorktree
      let resolvedWorktree = placementResolution.resolvedWorktree

      const authorityCapability = consumeWorkerAuthorityCapability({
        params,
        runtime,
        agent,
        createsWorktree,
        resolvedWorktreeId: resolvedWorktree?.id
      })
      const startOptions = buildWorkerStartOptions({
        params,
        requestedWorktree,
        resolvedWorktreeId: resolvedWorktree?.id,
        creationRepoId: creationWorktree?.repoId,
        createsWorktree,
        agent,
        launchReceipt: launch.receipt,
        authorityCapability,
        readinessTimeoutMs
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
      const placement = buildInitialWorkerPlacementReceipt({
        resolvedWorktreeId: resolvedWorktree?.id,
        authorityPolicyRequested: Boolean(params.policy)
      })
      const effects = placement.effects
      let terminalHandle = params.terminal
      let terminalRevealWarning: string | undefined
      let failedStage = 'terminal_create'
      let setupReceipt: WorkerSetupReceipt = placement.setupReceipt
      let authorityIsolation
      let authorityLifecycle
      try {
        ;({ isolation: authorityIsolation, lifecycle: authorityLifecycle } =
          createWorkerAuthorityLaunch({
            capability: authorityCapability,
            dispatchId: started.dispatch.id,
            worktreeId: resolvedWorktree?.id
          }))
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
            effects,
            authorityIsolation
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
        if (authorityIsolation) {
          failedStage = 'authority_attestation'
        }
        const authorityAttestation = await persistWorkerAuthorityAttestation({
          isolation: authorityIsolation,
          runtime,
          db,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          terminalHandle,
          agent: agent as TuiAgent,
          processIncarnation: terminalAuthority.processIncarnation
        })
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
        await sendWorkerDispatchInput({
          runtime,
          terminalHandle,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          taskSpec: task.spec,
          coordinatorHandle: params.from,
          dispatchCapability: capability,
          depth: started.dispatch.depth,
          devMode: params.devMode,
          isolated: Boolean(authorityIsolation),
          effects
        })
        const worker = db.markWorkerDispatchReady(started.dispatch.id, effects)
        monitorWorkerAuthorityLifecycle({
          lifecycle: authorityLifecycle,
          db,
          runtime,
          runId: run.id,
          taskId: task.id,
          dispatchId: started.dispatch.id,
          terminalHandle
        })
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
          timeoutMs: readinessTimeoutMs,
          effects,
          residualResources: [],
          ...(authorityAttestation ? { authorityIsolation: authorityAttestation } : {}),
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
