import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { FederationEffect } from './orchestration-federation-effects'
import { initialWorkerSetupReceipt, type WorkerSetupReceipt } from './orchestration-worker-topology'
import {
  monitorFederatedSetup,
  persistFederatedReadinessStage,
  persistFederatedSetupSpawnFailure,
  persistFederatedSetupWaitOutcome
} from './orchestration-federation-setup'
import { FederationAttachStartParams } from './orchestration-federation-start-schema'
import { failFederatedAttachmentWithReceipt } from './orchestration-federation-start-receipt'
import {
  createOrchestrationAgentReadinessDeadline,
  prepareOrchestrationAgentPrompt,
  waitForOrchestrationProvisioning
} from './orchestration-agent-prompt-readiness'
import { deliverOrchestrationWorkerPrompt } from './orchestration-worker-prompt-delivery'
import { createOrchestrationWorkerTerminalIdentity } from './orchestration-worker-terminal-identity'
import { provisionFederatedWorkerTerminal } from './orchestration-worker-terminal-provisioning'
import { finalizeRemoteWorkerAttachment } from './orchestration-worker-finalization'
import { createFederatedWorkerWorktree } from './orchestration-federation-worktree-provisioning'

export const ORCHESTRATION_FEDERATION_ATTACH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.federationAttachStart',
    params: FederationAttachStartParams,
    handler: async (params, { runtime, orchestrationMutation, signal }) => {
      const readiness = createOrchestrationAgentReadinessDeadline(
        'orchestration.federationAttachStart',
        params,
        signal
      )
      if (!orchestrationMutation) {
        throw new OrchestrationError(
          'invalid_argument',
          'Federated worker attachment requires a durable retry request.'
        )
      }
      if (params.worktree === 'current' || params.worktree === 'new-child') {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote worker requires an exact existing worktree or new-top-level.'
        )
      }
      const createsWorktree = params.worktree === 'new-top-level'
      if (createsWorktree && (!params.name || !params.repo)) {
        throw new OrchestrationError(
          'invalid_argument',
          'A remote new-top-level worktree requires --name and an explicit --repo.'
        )
      }
      if (createsWorktree && params.terminal) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal cannot combine with remote new-worktree creation.'
        )
      }
      if (
        !createsWorktree &&
        (params.name || params.repo || params.baseBranch || params.setup || params.setupSource)
      ) {
        throw new OrchestrationError(
          'invalid_argument',
          'Creation and setup options apply only to remote new-top-level worktrees.'
        )
      }
      if (params.terminal && params.agent) {
        throw new OrchestrationError(
          'invalid_argument',
          '--terminal reuses an existing agent and cannot combine with --agent.'
        )
      }
      const agent = params.agent
      if (!params.terminal && (!agent || !isTuiAgent(agent))) {
        throw new OrchestrationError(
          'agent_unconfigured',
          'A configured --agent is required when federated worker-start creates a terminal.'
        )
      }
      if (agent) {
        runtime.validateOrchestrationAgentLauncher(agent as TuiAgent)
      }
      if (createsWorktree) {
        await assertOrchestrationWorktreeCreationSupported({
          runtime,
          repoSelector: params.repo as string,
          existingPlacement: 'an exact existing folder workspace'
        })
      }

      const db = runtime.getOrchestrationDb()
      db.createRemoteDispatchAttachment({
        dispatchId: params.dispatchId,
        taskId: params.taskId,
        homePeerFingerprint: orchestrationMutation.callerFingerprint,
        protocolVersion: params.protocolVersion,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      const effects: FederationEffect[] = []
      const terminalIdentity = createOrchestrationWorkerTerminalIdentity(params.dispatchId)
      let failedStage = createsWorktree ? 'worktree_create' : 'worktree_resolve'
      let worktree
      let terminalHandle = params.terminal
      const setupSource = createsWorktree
        ? (params.setupSource ?? (params.setup ? 'explicit_request' : 'orchestration_default'))
        : 'existing_worktree'
      let setup: WorkerSetupReceipt = initialWorkerSetupReceipt(
        createsWorktree,
        params.setup,
        setupSource
      )
      try {
        if (createsWorktree) {
          const setupDecision = params.setup ?? 'run'
          const created = await waitForOrchestrationProvisioning(
            createFederatedWorkerWorktree({
              runtime,
              db,
              dispatchId: params.dispatchId,
              repo: params.repo as string,
              name: params.name as string,
              baseBranch: params.baseBranch,
              displayName: params.displayName,
              comment: params.comment,
              setupDecision,
              setupSource,
              agent: agent as TuiAgent,
              signal: readiness.signal,
              terminalIdentity,
              effects
            }),
            readiness.signal
          )
          worktree = created.worktree
          terminalHandle = created.terminalHandle
          setup = created.setup
        } else {
          worktree = await runtime.showManagedWorktree(params.worktree).catch(() => {
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
            if (
              !(await runtime.isTerminalRunningAgent(terminalHandle, {
                signal: readiness.signal,
                deadlineMs: readiness.deadlineMs
              }))
            ) {
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
            const terminal = await provisionFederatedWorkerTerminal({
              runtime,
              db,
              dispatchId: params.dispatchId,
              worktreeId: worktree.id,
              taskId: params.taskId,
              agent: agent as TuiAgent,
              signal: readiness.signal,
              terminalIdentity,
              effects
            })
            terminalHandle = terminal.handle
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
        const promptTarget = await prepareOrchestrationAgentPrompt(runtime, terminalHandle, {
          deadlineMs: readiness.deadlineMs,
          signal: readiness.signal,
          onWaitResult: (wait) => {
            persistFederatedSetupWaitOutcome({ ...setupStage, wait })
            if (!wait.satisfied && setup.state === 'failed') {
              failedStage = 'setup_wait'
            }
          }
        })
        const capability = db.prepareRemoteAttachmentAuthority({
          dispatchId: params.dispatchId,
          paneKey: promptTarget.paneKey,
          processIncarnation: promptTarget.processIncarnation,
          worktreeId: worktree.id,
          terminalHandle,
          setupState: setup.state,
          effects
        })
        failedStage = 'dispatch_input'
        await deliverOrchestrationWorkerPrompt({
          runtime,
          terminalHandle,
          taskId: params.taskId,
          dispatchId: params.dispatchId,
          taskSpec: params.taskSpec,
          coordinatorHandle: 'Run home (relayed by Orca)',
          dispatchCapability: capability,
          devMode: params.devMode,
          beforeWrite: promptTarget.beforeWrite,
          effects
        })
        const attachment = finalizeRemoteWorkerAttachment(db, params.dispatchId, effects)
        monitorFederatedSetup({ ...setupStage, runtime })
        return {
          dispatchId: params.dispatchId,
          state: attachment.state,
          stage: attachment.stage,
          runtimeEpoch: runtime.getRuntimeId(),
          worktreeId: worktree.id,
          terminalHandle,
          setup,
          effects,
          residualResources: []
        }
      } catch (error) {
        return failFederatedAttachmentWithReceipt({
          db,
          dispatchId: params.dispatchId,
          runtimeEpoch: runtime.getRuntimeId(),
          failedStage,
          error,
          setup
        })
      }
    }
  })
]
