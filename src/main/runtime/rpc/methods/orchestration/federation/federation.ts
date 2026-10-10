import { waitForWorkerAgentReady } from '../../../../launched-agent-composer-readiness'
import { describeTerminalWaitBlockedReason } from '../../../../../../shared/terminal-wait-blocked-reason-legacy-alias'
import { buildDispatchPreamble } from '../../../../orchestration/preamble'
import { sendAgentTurn } from '../../../../orchestration/send-agent-turn'
import { createWorkerBriefWriteGuard } from '../../../../launched-agent-write-guard'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { defineMethod } from '../../../core'
import { assertOrchestrationWorktreeCreationSupported } from '../worker/folder-worktree-placement'
import type { FederationEffect } from './federation-effects'
import { launchFederatedWorkerAgent } from './federated-worker-agent-launch'
import type { WorkerSetupReceipt } from '../worker/worker-topology'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './federation-setup'
import { FederationAttachStartParams } from './federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './federation-start-receipt'
import { prepareFederationWorkerLaunchOnHost } from '../worker/worker-opencode-model-preflight'
import {
  isWorkerStartTimeoutWithinTimerLimit,
  resolveWorkerStartReadinessTimeoutMs
} from '../../../../../../shared/orchestration-timing-budgets'
import { assertWorkerStartTaskSpecWithinPromptBudget } from '../worker/worker-start-prompt-budget'
import { prepareFederatedAttachmentAuthority } from './federation-attachment-authority'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    permission: 'workspace',
    params: FederationAttachStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Federated worker attachment requires a durable retry request.'
        )
      }
      await assertWorkerStartTaskSpecWithinPromptBudget(params.taskSpec)
      if (!isWorkerStartTimeoutWithinTimerLimit(params.timeoutMs)) {
        throw new OrchestrationError(
          'invalid_argument',
          '--timeout-ms is too large for worker-start transport grace; the derived timeout must fit within the timer limit.'
        )
      }
      const readinessTimeoutMs = resolveWorkerStartReadinessTimeoutMs(params.timeoutMs)
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote worker requires an exact existing worktree or new-top-level.'
        )
      }
      const createsWorktree = params.worktree === 'new-top-level'
      const { agent, launch } = await prepareFederationWorkerLaunchOnHost({
        params,
        createsWorktree,
        runtime
      })
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo as string,
          existingPlacement: 'an exact existing folder workspace'
        })
      }

      const db = runtime.getOrchestrationDb()
      db.createRemoteDispatchAttachment({
        runId: params.runId,
        dispatchId: params.dispatchId,
        taskId: params.taskId,
        homePeerFingerprint: orchestrationMutation.callerFingerprint,
        protocolVersion: params.protocolVersion,
        runtimeEpoch: runtime.getRuntimeId(),
        depth: params.depth,
        mutationReceipt: orchestrationMutation
      })
      const effects: FederationEffect[] = []
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle = params.terminal
      const setupSource = createsWorktree
        ? (params.setupSource ?? (params.setup ? 'explicit_request' : 'orchestration_default'))
        : 'existing_worktree'
      let setup: WorkerSetupReceipt = {
        requested: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        effective: createsWorktree ? (params.setup ?? 'run') : 'not_applicable',
        source: setupSource,
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: createsWorktree ? 'not_configured' : 'not_applicable'
      }
      try {
        const launchAgent = (existing?: { id: string }) =>
          launchFederatedWorkerAgent({
            runtime,
            db,
            params,
            agent,
            launchPreferences: launch.preferences,
            ...(existing ? { worktree: existing } : {}),
            setupSource,
            effects,
            onSetup: (created) => {
              setup = created
            },
            onStage: (stage) => {
              failedStage = stage
            }
          })
        if (createsWorktree) {
          ;({ worktree, terminalHandle } = await launchAgent())
        } else {
          worktree = await runtime.showManagedTerminalWorkspace(params.worktree).catch(() => {
            throw new OrchestrationError(
              'worktree_not_found_on_server',
              `Worktree ${params.worktree} was not found on the selected worker server.`
            )
          })
          effects.push(
            { kind: 'worktree', action: 'reused', id: worktree.id },
            { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
          )
          if (terminalHandle) {
            const terminal = await runtime.showTerminal(terminalHandle)
            if (terminal.worktreeId !== worktree.id) {
              throw new OrchestrationError(
                'terminal_worktree_mismatch',
                `Terminal ${terminalHandle} does not belong to worktree ${worktree.id}.`
              )
            }
            if (!(await runtime.isTerminalRunningAgent(terminalHandle))) {
              throw new OrchestrationError(
                'agent_unconfigured',
                `Terminal ${terminalHandle} is not running a recognized agent.`
              )
            }
            effects.push({
              kind: 'terminal',
              role: 'agent',
              action: 'reused',
              id: terminalHandle
            })
          } else {
            failedStage = 'terminal_create'
            ;({ terminalHandle } = await launchAgent(worktree))
          }
        }
        if (!worktree || !terminalHandle) {
          throw new Error('Federated worker topology did not resolve.')
        }
        const setupStage = {
          db,
          dispatchId: params.dispatchId,
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects
        }
        if (persistFederatedSetupSpawnFailure(setupStage)) {
          failedStage = 'setup_start'
          throw new Error('Setup terminal failed to start before the gated agent launch.')
        }
        persistFederatedReadinessStage(setupStage)
        failedStage = 'agent_readiness'
        const wait = await waitForWorkerAgentReady(runtime, terminalHandle, {
          agent,
          reusesTerminal: Boolean(params.terminal),
          timeoutMs: readinessTimeoutMs
        })
        persistFederatedSetupWaitOutcome({ ...setupStage, wait })
        if (!wait.satisfied) {
          if (setup.state === 'failed') {
            failedStage = 'setup_wait'
          }
          throw new Error(
            wait.blockedReason
              ? `Agent startup blocked: ${describeTerminalWaitBlockedReason(wait.blockedReason)}`
              : `Agent did not become ready (${wait.status}).`
          )
        }
        prepareFederatedAttachmentAuthority({
          runtime,
          db,
          dispatchId: params.dispatchId,
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects,
          reusesTerminal: Boolean(params.terminal)
        })
        failedStage = 'dispatch_input'
        // A shell back at its prompt also reads as ready, so the brief needs the agent found in front.
        const briefGuard = createWorkerBriefWriteGuard(runtime, agent, !params.terminal)
        const prompt = await sendAgentTurn({
          kind: 'terminal',
          runtime,
          handle: terminalHandle,
          ...(briefGuard ? { beforeWrite: briefGuard.beforeWrite } : {}),
          turn: {
            purpose: 'dispatch-preamble',
            operationId: orchestrationMutation.requestId,
            body: buildDispatchPreamble({
              taskId: params.taskId,
              dispatchId: params.dispatchId,
              taskSpec: params.taskSpec,
              coordinatorHandle: 'Run home (relayed by Orca)',
              workerHandle: terminalHandle,
              devMode: params.devMode,
              // Why the worker host's own setting: enforcement runs here, with this
              // host's code, against this host's cap.
              canDispatchSubWorkers: (params.depth ?? 1) < runtime.getNestedWorkerMaxDepth(),
              cliCommand: runtime.getTerminalOrchestrationCliCommand(terminalHandle)
            })
          }
        }).finally(() => briefGuard?.dispose())
        effects.push({
          kind: 'dispatch_input',
          role: 'agent',
          id: terminalHandle,
          state: 'accepted'
        })
        const attachment = db.markRemoteAttachmentReady(params.dispatchId, effects)
        monitorFederatedSetup({ ...setupStage, runtime })
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          stage: attachment.stage,
          runtimeEpoch: runtime.getRuntimeId(),
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          launch: launch.receipt,
          effects,
          ...(prompt.prompt ? { prompt: prompt.prompt } : {}),
          residualResources: []
        }
      } catch (error) {
        return failFederatedAttachmentWithReceipt({
          db,
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          failedStage,
          error,
          setup,
          launch: launch.receipt
        })
      }
    }
  })
]
